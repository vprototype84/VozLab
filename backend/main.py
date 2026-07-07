import asyncio
import os
import sys
import uuid
import json
import time
import signal
import tempfile
import threading
import subprocess
import webbrowser
import unicodedata
from pathlib import Path
from datetime import datetime
from typing import Dict

from fastapi import FastAPI, File, UploadFile, HTTPException, Request, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Transcriptor IA")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache(request: Request, call_next):
    """Evita que el WebView sirva un frontend cacheado tras actualizar la app."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response

UPLOAD_DIR = Path(tempfile.gettempdir()) / "transcriptor_uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Antigüedad máxima de un archivo subido/convertido antes de purgarlo (segundos).
_UPLOAD_TTL = 12 * 3600


def _purge_old_uploads(ttl: int = _UPLOAD_TTL) -> None:
    """Borra archivos antiguos de UPLOAD_DIR para no acumular audio/vídeo en disco.

    Best-effort; se llama al iniciar una transcripción nueva. No elimina los jobs
    en memoria: si un job antiguo pierde su archivo, los endpoints ya devuelven 404
    con un mensaje claro."""
    import time as _time
    now = _time.time()
    try:
        for f in UPLOAD_DIR.iterdir():
            try:
                if f.is_file() and now - f.stat().st_mtime > ttl:
                    f.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass

jobs: Dict[str, dict] = {}
meetings: Dict[str, dict] = {}
screenrecs: Dict[str, dict] = {}
_booth_sessions: Dict[str, asyncio.Event] = {}
_booth_job_ids: Dict[str, str] = {}
_booth_stop_signals: Dict[str, bool] = {}

SUPPORTED = {".mp3", ".m4a", ".wav", ".ogg", ".webm", ".mp4", ".flac", ".aac", ".mov"}

# En Windows el helper de captura es un script Python (meetingrec_win.py, usa
# WASAPI loopback vía 'soundcard' + ffmpeg para el vídeo) ejecutado con el mismo
# intérprete que el backend — evita depender de un toolchain de compilación nativo.
# En macOS era un binario Swift compilado (build_native.sh).
MEETING_REC = Path(__file__).parent / "native" / ("meetingrec_win.py" if sys.platform == "win32" else "meetingrec")
# NARRAVOZ-style: la ruta de ffmpeg/ffprobe puede venir inyectada por el lanzador Electron
# (empaquetado), si no se usa la del PATH (dev / instalación manual).
FFMPEG = os.environ.get("TRANSCRIPTORIA_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("TRANSCRIPTORIA_FFPROBE", "ffprobe")


def _meetingrec_cmd(*args: str) -> list:
    if sys.platform == "win32":
        return [sys.executable, str(MEETING_REC), *args]
    return [str(MEETING_REC), *args]


def _screen_recording_ok(request_if_missing: bool = False) -> bool:
    """¿Tiene la app permiso de captura de pantalla? En Windows no existe un permiso
    equivalente al de macOS (Grabación de pantalla) a nivel de app: el propio helper
    nativo reporta el error si la API de captura lo rechaza."""
    return True


def _control_recorder(proc: subprocess.Popen, action: str) -> None:
    """Envía PAUSE/RESUME/STOP al helper de captura.

    En macOS el binario Swift escucha señales POSIX (SIGUSR1/SIGUSR2/SIGTERM).
    En Windows no existen esas señales para procesos normales, así que
    meetingrec-win.exe lee comandos de una línea por stdin en su lugar.
    """
    if sys.platform == "win32":
        try:
            if proc.stdin:
                proc.stdin.write(f"{action}\n".encode("utf-8"))
                proc.stdin.flush()
        except Exception:
            pass
    else:
        sig = {"PAUSE": signal.SIGUSR1, "RESUME": signal.SIGUSR2, "STOP": signal.SIGTERM}[action]
        try:
            proc.send_signal(sig)
        except Exception:
            pass


@app.post("/api/transcribe")
async def start_transcription(
    file: UploadFile = File(...),
    language: str = Form(default="es"),
    model_size: str = Form(default="auto"),
    diarize: bool = Form(default=True),
    num_speakers: int = Form(default=0),
):
    ext = Path(file.filename or "audio.mp3").suffix.lower() or ".mp3"
    if ext not in SUPPORTED:
        raise HTTPException(400, f"Formato no soportado: {ext}")

    _purge_old_uploads()

    job_id = str(uuid.uuid4())
    audio_path = UPLOAD_DIR / f"{job_id}{ext}"

    # Escribir en disco por chunks (1 MB) — no cargar archivos grandes en RAM
    import aiofiles
    async with aiofiles.open(audio_path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)  # 1 MB
            if not chunk:
                break
            await out.write(chunk)

    try:
        _r = subprocess.run(
            [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", str(audio_path)],
            capture_output=True, text=True, timeout=30,
        )
        audio_duration = float(json.loads(_r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        audio_duration = 0.0

    jobs[job_id] = {
        "id": job_id,
        "filename": file.filename,
        "audio_path": str(audio_path),
        "language": language,
        "model_size": model_size,
        "diarize": diarize,
        "num_speakers": num_speakers or None,
        "audio_duration": audio_duration,
    }
    return {"job_id": job_id}


@app.get("/api/transcribe/{job_id}/stream")
async def stream_transcription(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[job_id]
    from transcriber import transcribe_audio

    async def generate():
        all_segments = []
        try:
            async for event in transcribe_audio(job):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("status") == "segment":
                    all_segments.append(event["segment"])
                elif event.get("status") == "completed":
                    from history import save_to_history
                    # Los segmentos del evento 'completed' ya traen los hablantes
                    # asignados por la diarización; preferirlos al stream en vivo.
                    final_segments = event.get("segments", all_segments)
                    await save_to_history(job, final_segments)
                    break
                elif event.get("status") == "error":
                    break
        except Exception as exc:
            yield f"data: {json.dumps({'status': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/process")
async def process_text(request: Request):
    body = await request.json()
    text = body.get("text", "").strip()
    action = body.get("action", "clean")
    if not text:
        raise HTTPException(400, "No hay texto para procesar")

    from ollama_client import process_with_ollama

    async def generate():
        try:
            async for chunk in process_with_ollama(text, action):
                yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        finally:
            yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/audio/{job_id}")
async def get_audio(job_id: str):
    """Sirve el audio original para el preview de hablantes (soporta Range/seek)."""
    from fastapi.responses import FileResponse
    job = jobs.get(job_id)
    if job and Path(job["audio_path"]).exists():
        return FileResponse(job["audio_path"])
    # Fallback: el job puede no estar en memoria tras reiniciar; busca por id en disco.
    for p in UPLOAD_DIR.glob(f"{job_id}.*"):
        return FileResponse(str(p))
    raise HTTPException(404, "Audio no disponible")


@app.post("/api/stash")
async def stash_audio(file: UploadFile = File(...)):
    """Guarda temporalmente una grabación del cliente para poder descargarla desde el servidor."""
    ext = Path(file.filename or "audio.webm").suffix.lower() or ".webm"
    job_id = str(uuid.uuid4())
    path = UPLOAD_DIR / f"{job_id}{ext}"
    import aiofiles
    async with aiofiles.open(path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)
    return {"job_id": job_id}


@app.get("/api/download/{job_id}")
async def download_audio(job_id: str, name: str = "audio"):
    """Convierte el audio a M4A (AAC) y lo entrega como descarga."""
    src = None
    job = jobs.get(job_id)
    if job and Path(job["audio_path"]).exists():
        src = Path(job["audio_path"])
    else:
        for p in UPLOAD_DIR.glob(f"{job_id}.*"):
            if not p.name.endswith("_dl.m4a"):
                src = p
                break
    if not src:
        raise HTTPException(404, "Audio no disponible")

    out = UPLOAD_DIR / f"{job_id}_dl.m4a"
    if not out.exists():
        # loudnorm → todas las descargas quedan a un volumen homogéneo (micro y reunión iguales).
        import functools
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, functools.partial(
                subprocess.run,
                [FFMPEG, "-y", "-i", str(src),
                 "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                 "-c:a", "aac", "-b:a", "128k", str(out)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        )
    if not out.exists():
        raise HTTPException(500, "No se pudo convertir el audio")

    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in name).strip("_") or "audio"
    from fastapi.responses import FileResponse
    return FileResponse(
        str(out),
        media_type="audio/mp4",
        filename=f"{safe}.m4a",
    )


@app.get("/api/meeting/permission")
async def meeting_permission(request_access: bool = False):
    """Estado del permiso de Grabación de pantalla (necesario para capturar el audio del sistema)."""
    ok = _screen_recording_ok(request_if_missing=request_access)
    return {"granted": ok}


@app.post("/api/meeting/start")
async def meeting_start():
    if not MEETING_REC.exists():
        raise HTTPException(500, "El componente de captura no está compilado (build_native.sh).")

    job_id = str(uuid.uuid4())
    base = str(UPLOAD_DIR / f"meeting_{job_id}")
    proc = subprocess.Popen(
        _meetingrec_cmd(base),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    rec = {
        "proc": proc, "base": base, "started": time.time(),
        "levels": {"sys": 0.0, "mic": 0.0, "paused": False},
        "error": None, "ready": False,
    }

    def _reader():
        # Lee niveles (S/M), estado de pausa y errores del helper.
        for raw in proc.stdout:
            line = raw.decode("utf-8", "ignore").strip()
            if line.startswith("S "):
                try: rec["levels"]["sys"] = float(line[2:])
                except ValueError: pass
            elif line.startswith("M "):
                try: rec["levels"]["mic"] = float(line[2:])
                except ValueError: pass
            elif line == "PAUSED":
                rec["levels"]["paused"] = True
            elif line == "RESUMED":
                rec["levels"]["paused"] = False
            elif line == "STARTED":
                rec["ready"] = True
            elif "NO_PERMISSION" in line:
                rec["error"] = "permission"
            elif line.startswith(("STREAM_ERROR", "NO_DISPLAY", "WRITE_ERROR")):
                rec["error"] = line

    threading.Thread(target=_reader, daemon=True).start()

    # Esperar hasta ~3 s a que confirme arranque o reporte fallo.
    deadline = time.time() + 3.0
    while time.time() < deadline:
        if rec["error"] == "permission":
            raise HTTPException(
                403,
                "Falta el permiso de Grabación de pantalla. Ve a Ajustes del Sistema → "
                "Privacidad y seguridad → Grabación de pantalla, activa 'meetingrec' y vuelve a intentarlo.",
            )
        if rec["error"]:
            raise HTTPException(500, f"No se pudo iniciar la captura: {rec['error']}")
        if rec["ready"] or proc.poll() is not None:
            break
        time.sleep(0.1)
    if proc.poll() is not None and not rec["ready"]:
        raise HTTPException(500, "El componente de captura se cerró inesperadamente.")

    meetings[job_id] = rec
    return {"job_id": job_id}


@app.post("/api/meeting/pause")
async def meeting_pause(request: Request):
    body = await request.json()
    rec = meetings.get(body.get("job_id"))
    if not rec:
        raise HTTPException(404, "Grabación no encontrada")
    try:
        _control_recorder(rec["proc"], "PAUSE")
    except Exception:
        pass
    return {"ok": True, "paused": True}


@app.post("/api/meeting/resume")
async def meeting_resume(request: Request):
    body = await request.json()
    rec = meetings.get(body.get("job_id"))
    if not rec:
        raise HTTPException(404, "Grabación no encontrada")
    try:
        _control_recorder(rec["proc"], "RESUME")
    except Exception:
        pass
    return {"ok": True, "paused": False}


@app.get("/api/meeting/levels")
async def meeting_levels(job_id: str):
    rec = meetings.get(job_id)
    if not rec:
        return {"sys": 0.0, "mic": 0.0, "paused": False, "active": False}
    lv = rec["levels"]
    return {"sys": lv["sys"], "mic": lv["mic"], "paused": lv["paused"], "active": True}


@app.post("/api/meeting/stop")
async def meeting_stop(request: Request):
    body = await request.json()
    job_id = body.get("job_id")
    language = body.get("language", "es")
    model_size = body.get("model_size", "auto")
    diarize = bool(body.get("diarize", True))
    num_speakers = int(body.get("num_speakers", 0)) or None

    rec = meetings.pop(job_id, None)
    if not rec:
        raise HTTPException(404, "Grabación no encontrada")

    proc = rec["proc"]
    base = rec["base"]

    # Parar el helper limpiamente y esperar a que cierre los WAV.
    try:
        _control_recorder(proc, "STOP")
        proc.wait(timeout=15)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    sys_wav = Path(f"{base}_system.wav")
    mic_wav = Path(f"{base}_mic.wav")
    out_wav = UPLOAD_DIR / f"{job_id}.wav"

    have_sys = sys_wav.exists() and sys_wav.stat().st_size > 1024
    have_mic = mic_wav.exists() and mic_wav.stat().st_size > 1024
    if not have_sys and not have_mic:
        raise HTTPException(422, "No se capturó audio. ¿Había sonido en la reunión y micrófono activo?")

    # Mezclar a un único WAV 16 kHz mono, normalizando CADA fuente para que el
    # sistema y el micrófono queden a un volumen parecido (conversación equilibrada).
    if have_sys and have_mic:
        cmd = [FFMPEG, "-y", "-i", str(sys_wav), "-i", str(mic_wav),
               "-filter_complex",
               "[0:a]dynaudnorm[s];[1:a]dynaudnorm[m];[s][m]amix=inputs=2:duration=longest:normalize=0",
               "-ac", "1", "-ar", "16000", str(out_wav)]
    else:
        src = sys_wav if have_sys else mic_wav
        cmd = [FFMPEG, "-y", "-i", str(src), "-af", "dynaudnorm",
               "-ac", "1", "-ar", "16000", str(out_wav)]

    # Ejecutar ffmpeg en un executor para no bloquear el event loop de asyncio.
    import functools
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None, functools.partial(subprocess.run, cmd,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    )

    # Limpiar las pistas crudas.
    for p in (sys_wav, mic_wav):
        try:
            p.unlink()
        except OSError:
            pass

    if not out_wav.exists():
        raise HTTPException(500, "No se pudo procesar el audio capturado.")

    # Calcular duración real del WAV para que la barra de progreso se calibre igual
    # que en las subidas de archivo normales.
    try:
        _r = subprocess.run(
            [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", str(out_wav)],
            capture_output=True, text=True, timeout=30,
        )
        audio_duration = float(json.loads(_r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        audio_duration = 0.0

    # Registrar como job normal → reutiliza el flujo de transcripción + diarización.
    stamp = datetime.now().strftime("%d/%m %H:%M")
    jobs[job_id] = {
        "id": job_id,
        "filename": f"Reunión {stamp}",
        "audio_path": str(out_wav),
        "language": language,
        "model_size": model_size,
        "diarize": diarize,
        "num_speakers": num_speakers,
        "audio_duration": audio_duration,
    }
    return {"job_id": job_id}


@app.post("/api/meeting/cancel")
async def meeting_cancel(request: Request):
    body = await request.json()
    rec = meetings.pop(body.get("job_id"), None)
    if not rec:
        return {"ok": True}
    try:
        _control_recorder(rec["proc"], "STOP")
        rec["proc"].wait(timeout=10)
    except Exception:
        try:
            rec["proc"].kill()
        except Exception:
            pass
    for suffix in ("_system.wav", "_mic.wav"):
        try:
            Path(rec["base"] + suffix).unlink()
        except OSError:
            pass
    return {"ok": True}


@app.post("/api/screenrec/start")
async def screenrec_start():
    if not MEETING_REC.exists():
        raise HTTPException(500, "El componente de captura no está compilado (build_native.sh).")

    job_id = str(uuid.uuid4())
    base = str(UPLOAD_DIR / f"screenrec_{job_id}")
    proc = subprocess.Popen(
        _meetingrec_cmd(base, "--video"),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    rec = {
        "proc": proc, "base": base, "started": time.time(),
        "levels": {"sys": 0.0, "mic": 0.0, "paused": False},
        "error": None, "ready": False,
    }

    def _reader():
        for raw in proc.stdout:
            line = raw.decode("utf-8", "ignore").strip()
            if line.startswith("S "):
                try: rec["levels"]["sys"] = float(line[2:])
                except ValueError: pass
            elif line.startswith("M "):
                try: rec["levels"]["mic"] = float(line[2:])
                except ValueError: pass
            elif line == "PAUSED":
                rec["levels"]["paused"] = True
            elif line == "RESUMED":
                rec["levels"]["paused"] = False
            elif line == "STARTED":
                rec["ready"] = True
            elif "NO_PERMISSION" in line:
                rec["error"] = "permission"
            elif line.startswith(("STREAM_ERROR", "NO_DISPLAY", "WRITE_ERROR", "VIDEOWRITER_BAD_STATUS")):
                rec["error"] = line

    threading.Thread(target=_reader, daemon=True).start()

    deadline = time.time() + 3.0
    while time.time() < deadline:
        if rec["error"] == "permission":
            raise HTTPException(
                403,
                "Falta el permiso de Grabación de pantalla. Ve a Ajustes del Sistema → "
                "Privacidad y seguridad → Grabación de pantalla, activa 'meetingrec' y vuelve a intentarlo.",
            )
        if rec["error"]:
            raise HTTPException(500, f"No se pudo iniciar la captura: {rec['error']}")
        if rec["ready"] or proc.poll() is not None:
            break
        time.sleep(0.1)
    if proc.poll() is not None and not rec["ready"]:
        raise HTTPException(500, "El componente de captura se cerró inesperadamente.")

    screenrecs[job_id] = rec
    return {"job_id": job_id}


@app.post("/api/screenrec/pause")
async def screenrec_pause(request: Request):
    body = await request.json()
    rec = screenrecs.get(body.get("job_id"))
    if not rec:
        raise HTTPException(404, "Grabación no encontrada")
    try:
        _control_recorder(rec["proc"], "PAUSE")
    except Exception:
        pass
    return {"ok": True, "paused": True}


@app.post("/api/screenrec/resume")
async def screenrec_resume(request: Request):
    body = await request.json()
    rec = screenrecs.get(body.get("job_id"))
    if not rec:
        raise HTTPException(404, "Grabación no encontrada")
    try:
        _control_recorder(rec["proc"], "RESUME")
    except Exception:
        pass
    return {"ok": True, "paused": False}


@app.get("/api/screenrec/levels")
async def screenrec_levels(job_id: str):
    rec = screenrecs.get(job_id)
    if not rec:
        return {"sys": 0.0, "mic": 0.0, "paused": False, "active": False}
    lv = rec["levels"]
    return {"sys": lv["sys"], "mic": lv["mic"], "paused": lv["paused"], "active": True}


@app.post("/api/screenrec/stop")
async def screenrec_stop(request: Request):
    body = await request.json()
    job_id = body.get("job_id")
    language = body.get("language", "es")
    model_size = body.get("model_size", "auto")
    diarize = bool(body.get("diarize", True))
    num_speakers = int(body.get("num_speakers", 0)) or None

    rec = screenrecs.pop(job_id, None)
    if not rec:
        raise HTTPException(404, "Grabación no encontrada")

    proc = rec["proc"]
    base = rec["base"]

    try:
        _control_recorder(proc, "STOP")
        proc.wait(timeout=15)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    sys_wav = Path(f"{base}_system.wav")
    mic_wav = Path(f"{base}_mic.wav")
    raw_mp4 = Path(f"{base}_video_raw.mp4")
    out_wav = UPLOAD_DIR / f"{job_id}.wav"
    out_mp4 = UPLOAD_DIR / f"{job_id}_screen.mp4"

    have_sys = sys_wav.exists() and sys_wav.stat().st_size > 1024
    have_mic = mic_wav.exists() and mic_wav.stat().st_size > 1024
    have_vid = raw_mp4.exists() and raw_mp4.stat().st_size > 1024

    if not have_sys and not have_mic:
        raise HTTPException(422, "No se capturó audio. ¿Había sonido y micrófono activo?")
    if not have_vid:
        raise HTTPException(422, "No se capturó vídeo. Comprueba el permiso de Grabación de pantalla.")

    import functools

    def _run_ffmpeg(cmd: list) -> None:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode("utf-8", "ignore").strip()[-600:])

    loop = asyncio.get_event_loop()

    # Paso A: mezcla a WAV 16kHz mono para Whisper (idéntico a meeting_stop).
    if have_sys and have_mic:
        audio_cmd = [FFMPEG, "-y", "-i", str(sys_wav), "-i", str(mic_wav),
                     "-filter_complex",
                     "[0:a]dynaudnorm[s];[1:a]dynaudnorm[m];[s][m]amix=inputs=2:duration=longest:normalize=0",
                     "-ac", "1", "-ar", "16000", str(out_wav)]
    else:
        src = sys_wav if have_sys else mic_wav
        audio_cmd = [FFMPEG, "-y", "-i", str(src), "-af", "dynaudnorm",
                     "-ac", "1", "-ar", "16000", str(out_wav)]

    try:
        await loop.run_in_executor(None, functools.partial(_run_ffmpeg, audio_cmd))
    except RuntimeError as e:
        raise HTTPException(500, f"FFmpeg (audio 16kHz): {e}")

    # Paso B: mezcla a WAV estéreo 48kHz para el vídeo (operación independiente).
    mix_wav = UPLOAD_DIR / f"{job_id}_mix.wav"
    if have_sys and have_mic:
        mix_cmd = [FFMPEG, "-y", "-i", str(sys_wav), "-i", str(mic_wav),
                   "-filter_complex",
                   "[0:a]dynaudnorm[s];[1:a]dynaudnorm[m];[s][m]amix=inputs=2:duration=longest:normalize=0",
                   "-ac", "2", "-ar", "48000", str(mix_wav)]
    else:
        src = sys_wav if have_sys else mic_wav
        mix_cmd = [FFMPEG, "-y", "-i", str(src), "-af", "dynaudnorm",
                   "-ac", "2", "-ar", "48000", str(mix_wav)]

    try:
        await loop.run_in_executor(None, functools.partial(_run_ffmpeg, mix_cmd))
    except RuntimeError as e:
        raise HTTPException(500, f"FFmpeg (audio 48kHz): {e}")

    # Paso C: mux simple 2 entradas (vídeo + audio ya mezclado) → MP4 final.
    mux_cmd = [
        FFMPEG, "-y",
        "-i", str(raw_mp4),
        "-i", str(mix_wav),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out_mp4),
    ]

    try:
        await loop.run_in_executor(None, functools.partial(_run_ffmpeg, mux_cmd))
    except RuntimeError as e:
        raise HTTPException(500, f"FFmpeg (mux vídeo): {e}")

    for p in (sys_wav, mic_wav, raw_mp4, mix_wav):
        try:
            p.unlink()
        except OSError:
            pass

    if not out_wav.exists():
        raise HTTPException(500, "No se pudo procesar el audio para transcripción.")
    if not out_mp4.exists():
        raise HTTPException(500, "No se pudo generar el vídeo final.")

    try:
        _r = subprocess.run(
            [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", str(out_wav)],
            capture_output=True, text=True, timeout=30,
        )
        audio_duration = float(json.loads(_r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        audio_duration = 0.0

    stamp = datetime.now().strftime("%d/%m %H:%M")
    jobs[job_id] = {
        "id": job_id,
        "filename": f"Pantalla {stamp}",
        "audio_path": str(out_wav),
        "video_path": str(out_mp4),
        "language": language,
        "model_size": model_size,
        "diarize": diarize,
        "num_speakers": num_speakers,
        "audio_duration": audio_duration,
    }
    return {"job_id": job_id, "has_video": True}


@app.post("/api/screenrec/cancel")
async def screenrec_cancel(request: Request):
    body = await request.json()
    rec = screenrecs.pop(body.get("job_id"), None)
    if not rec:
        return {"ok": True}
    try:
        _control_recorder(rec["proc"], "STOP")
        rec["proc"].wait(timeout=10)
    except Exception:
        try:
            rec["proc"].kill()
        except Exception:
            pass
    for suffix in ("_system.wav", "_mic.wav", "_video_raw.mp4"):
        try:
            Path(rec["base"] + suffix).unlink()
        except OSError:
            pass
    return {"ok": True}


@app.get("/api/download-video/{job_id}")
async def download_video(job_id: str, name: str = "grabacion"):
    from fastapi.responses import FileResponse
    job = jobs.get(job_id)
    video_path = (job or {}).get("video_path")
    if not video_path or not Path(video_path).exists():
        raise HTTPException(404, "Vídeo no disponible")
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in name).strip("_") or "grabacion"
    return FileResponse(str(video_path), media_type="video/mp4", filename=f"{safe}.mp4")


@app.get("/api/status")
async def status():
    from ollama_client import check_ollama_available
    ollama_ok = await check_ollama_available()
    return {"status": "ok", "ollama": ollama_ok}


@app.get("/api/history")
async def list_history():
    from history import get_history
    return await get_history()


@app.get("/api/history/{item_id}")
async def get_history_item(item_id: str):
    from history import get_history_item as _get
    item = await _get(item_id)
    if not item:
        raise HTTPException(404, "No encontrado")
    return item


@app.delete("/api/history")
async def delete_all_history_endpoint():
    from history import delete_all_history
    count = await delete_all_history()
    return {"deleted": count}


@app.delete("/api/history/{item_id}")
async def delete_history_item_endpoint(item_id: str):
    from history import delete_history_item
    await delete_history_item(item_id)
    return {"ok": True}


@app.post("/api/history/{item_id}/pin")
async def pin_history_item_endpoint(item_id: str, request: Request):
    from history import set_pinned
    body = await request.json()
    pinned = bool(body.get("pinned", True))
    found = await set_pinned(item_id, pinned)
    if not found:
        raise HTTPException(404, "No encontrado")
    return {"ok": True, "pinned": pinned}


@app.post("/api/export/txt")
async def export_txt_endpoint(request: Request):
    body = await request.json()
    from export import export_txt
    content = export_txt(
        body.get("segments", []),
        body.get("processed", ""),
        body.get("action_label", ""),
    )
    fname = unicodedata.normalize("NFC", (body.get("filename", "transcripcion") or "transcripcion").replace(" ", "_"))
    return StreamingResponse(
        iter([content.encode("utf-8")]),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}.txt"'},
    )


@app.post("/api/export/docx")
async def export_docx_endpoint(request: Request):
    body = await request.json()
    from export import export_docx
    data = export_docx(
        body.get("segments", []),
        body.get("processed", ""),
        body.get("action_label", ""),
        body.get("filename", "transcripcion"),
        body.get("show_timestamps", True),
    )
    fname = unicodedata.normalize("NFC", (body.get("filename", "transcripcion") or "transcripcion").replace(" ", "_"))
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{fname}.docx"'},
    )


@app.post("/api/retranscribe")
async def retranscribe(request: Request):
    """Crea un nuevo job sobre el mismo audio ya subido, con ajustes distintos."""
    body = await request.json()
    original_id = body.get("job_id")
    original = jobs.get(original_id)
    if not original or not Path(original["audio_path"]).exists():
        raise HTTPException(404, "El audio ya no está disponible. Vuelve a grabar o sube el archivo.")

    new_id = str(uuid.uuid4())
    jobs[new_id] = {
        "id": new_id,
        "filename": original.get("filename", "retranscripcion"),
        "audio_path": original["audio_path"],
        "language": body.get("language", original.get("language", "es")),
        "model_size": body.get("model_size", original.get("model_size", "auto")),
        "diarize": bool(body.get("diarize", False)),
        "num_speakers": int(body.get("num_speakers", 0)) or None,
        "audio_duration": original.get("audio_duration", 0),
    }
    return {"job_id": new_id}


# ── Meeting Booth (grabación web via navegador del sistema) ──────────────────

@app.get("/meeting-booth")
async def meeting_booth_page():
    from fastapi.responses import FileResponse
    booth = Path(__file__).parent.parent / "renderer" / "meeting-booth.html"
    return FileResponse(str(booth), media_type="text/html")


@app.get("/api/meeting-booth/should-stop/{session_id}")
async def meeting_booth_should_stop(session_id: str):
    """La cabina web consulta este endpoint para saber si la app ha pedido detener."""
    return {"stop": _booth_stop_signals.get(session_id, False)}


@app.post("/api/meeting-booth/request-stop/{session_id}")
async def meeting_booth_request_stop(session_id: str):
    """La app pulsa 'Detener' y señaliza a la cabina que pare la grabación."""
    if session_id not in _booth_sessions:
        raise HTTPException(404, "Sesión no encontrada")
    _booth_stop_signals[session_id] = True
    return {"ok": True}


@app.get("/api/open-meeting-booth")
async def open_meeting_booth(
    lang: str = "es",
    model: str = "large-turbo",
    diarize: str = "true",
    speakers: int = 0,
):
    session_id = str(uuid.uuid4())
    _booth_sessions[session_id] = asyncio.Event()
    url = (
        f"http://localhost:8000/meeting-booth"
        f"?s={session_id}&lang={lang}&model={model}"
        f"&diarize={diarize}&speakers={speakers}"
    )
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: webbrowser.open(url))
    return {"session_id": session_id}


@app.get("/api/meeting-booth/ready/{session_id}")
async def meeting_booth_ready(session_id: str):
    if session_id not in _booth_sessions:
        raise HTTPException(404, "Sesión no encontrada")

    async def generate():
        event = _booth_sessions.get(session_id)
        if not event:
            yield f"data: {json.dumps({'error': 'session_not_found'})}\n\n"
            return
        try:
            await asyncio.wait_for(event.wait(), timeout=10800)  # 3 h máx.
        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'error': 'timeout'})}\n\n"
            return
        job_id = _booth_job_ids.get(session_id)
        _booth_sessions.pop(session_id, None)
        _booth_job_ids.pop(session_id, None)
        _booth_stop_signals.pop(session_id, None)
        if job_id:
            yield f"data: {json.dumps({'job_id': job_id})}\n\n"
        else:
            yield f"data: {json.dumps({'error': 'cancelled'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/api/meeting-booth/done/{session_id}/{job_id}")
async def meeting_booth_done(session_id: str, job_id: str):
    event = _booth_sessions.get(session_id)
    if not event:
        raise HTTPException(404, "Sesión no encontrada o ya cerrada")
    _booth_job_ids[session_id] = job_id
    event.set()
    return {"ok": True}


@app.post("/api/meeting-booth/cancel/{session_id}")
async def meeting_booth_cancel(session_id: str):
    event = _booth_sessions.pop(session_id, None)
    _booth_job_ids.pop(session_id, None)
    _booth_stop_signals.pop(session_id, None)
    if event:
        event.set()
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# TTS — Narrador de Voz
# ══════════════════════════════════════════════════════════════════

def _tts():
    """Importa el módulo tts de forma lazy para no cargar torch al arrancar."""
    import tts as _tts_mod
    return _tts_mod


@app.get("/api/tts/voices")
async def tts_list_voices():
    return _tts().list_voices()


@app.get("/api/tts/model-status")
async def tts_model_status():
    return _tts().model_status()


@app.get("/api/tts/profiles")
async def tts_list_profiles():
    return _tts().list_profiles()


@app.get("/api/tts/settings")
async def tts_get_settings():
    import tts_settings
    return tts_settings.public_settings()


@app.post("/api/tts/settings")
async def tts_update_settings(request: Request):
    """Cambia el motor de voz y/o la configuración de ElevenLabs.

    Body: {engine?, elevenlabs_api_key?, elevenlabs_model?}. Si llega una API key
    nueva (o se activa ElevenLabs), se valida contra la API y se devuelve el
    estado de la cuenta; si es inválida se responde 400 y no se guarda la clave.
    """
    import tts_settings, elevenlabs_engine
    body = await request.json()

    engine = body.get("engine")
    if engine is not None and engine not in ("chatterbox", "elevenlabs"):
        raise HTTPException(400, "Motor no válido")

    model = body.get("elevenlabs_model")
    if model is not None and model not in elevenlabs_engine.SUPPORTED_MODELS:
        raise HTTPException(400, "Modelo de ElevenLabs no válido")

    raw_key = body.get("elevenlabs_api_key")
    api_key = raw_key.strip() if isinstance(raw_key, str) else None

    account = None
    # Validar la clave si nos mandan una nueva, o si se activa ElevenLabs y ya hay una guardada.
    key_to_check = api_key
    if key_to_check is None and engine == "elevenlabs":
        key_to_check = tts_settings.get_settings().get("elevenlabs_api_key", "")
    if key_to_check:
        try:
            account = elevenlabs_engine.validate_key(key_to_check)
        except elevenlabs_engine.ElevenLabsError as exc:
            raise HTTPException(400, str(exc))

    changes = {}
    if engine is not None:
        changes["engine"] = engine
    if model is not None:
        changes["elevenlabs_model"] = model
    if api_key is not None:
        changes["elevenlabs_api_key"] = api_key

    tts_settings.update_settings(**changes)
    return {"settings": tts_settings.public_settings(), "account": account}


@app.post("/api/tts/generate")
async def tts_generate(request: Request):
    from fastapi.responses import JSONResponse
    t = _tts()
    body = await request.json()
    text          = (body.get("text") or "").strip()
    voice_id      = body.get("voice_id", "predefined/es_female")
    output_format = body.get("output_format", "mp3")
    language      = body.get("language")
    profile       = body.get("profile")

    def _parse_slider(value, lo, hi):
        """Convierte un valor de slider del body a float dentro de [lo, hi], o
        None si no viene informado o no es numérico (se usa el del perfil)."""
        if value is None:
            return None
        try:
            return max(lo, min(hi, float(value)))
        except (TypeError, ValueError):
            return None

    speed      = _parse_slider(body.get("speed"), 0.7, 1.2)
    stability  = _parse_slider(body.get("stability"), 0.0, 1.0)
    similarity = _parse_slider(body.get("similarity"), 0.0, 1.0)

    if not text:
        raise HTTPException(400, "El texto no puede estar vacío")
    if len(text) > 5000:
        raise HTTPException(400, "El texto es demasiado largo (máx. 5000 caracteres)")
    if output_format not in ("wav", "mp3"):
        output_format = "mp3"
    # Idioma de salida opcional; si no es válido, generate_speech usa el de la voz.
    if language not in ("es", "en", "en_es"):
        language = None
    # Perfil de voz opcional; si no es válido, generate_speech usa "normal".
    if profile not in t.PROFILES:
        profile = None

    # Purgar jobs/temporales TTS antiguos antes de crear uno nuevo (evita fugas).
    try:
        t.purge_old_jobs()
    except Exception:
        pass

    job_id = str(uuid.uuid4())
    t.tts_jobs[job_id] = {
        "id":            job_id,
        "status":        "pending",
        "progress":      0,
        "text":          text,
        "voice_id":      voice_id,
        "output_format": output_format,
        "language":      language,
        "profile":       profile,
        "output_path":   None,
        "error":         None,
        "created_at":    time.time(),
    }

    import functools
    loop = asyncio.get_event_loop()
    loop.run_in_executor(
        None,
        functools.partial(t.generate_speech, job_id, text, voice_id, output_format, language, profile,
                          speed=speed, stability=stability, similarity=similarity),
    )

    return {"job_id": job_id}


@app.post("/api/tts/preload")
async def tts_preload():
    """Dispara la carga del modelo en segundo plano (al abrir el panel del narrador)."""
    _tts().ensure_model_loaded()
    return {"ok": True}


@app.get("/api/tts/status/{job_id}")
async def tts_status(job_id: str):
    t = _tts()
    job = t.tts_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job no encontrado")
    return {
        "status":   job["status"],
        "progress": job["progress"],
        "error":    job.get("error"),
    }


@app.get("/api/tts/download/{job_id}")
async def tts_download(job_id: str):
    from fastapi.responses import FileResponse as FR
    t = _tts()
    job = t.tts_jobs.get(job_id)
    if not job or job["status"] != "completed":
        raise HTTPException(404, "Audio no disponible o generación no completada")
    out_path = job.get("output_path")
    if not out_path or not Path(out_path).exists():
        raise HTTPException(404, "Archivo no encontrado")
    fmt  = job.get("output_format", "mp3")
    mime = "audio/mpeg" if fmt == "mp3" else "audio/wav"
    fname = f"narracion_{job_id[:8]}.{fmt}"
    return FR(
        out_path,
        media_type=mime,
        filename=fname,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/tts/clone")
async def tts_clone_voice(
    audio: UploadFile = File(...),
    name: str = Form(...),
    ref_text: str = Form(...),
    language: str = Form(default="es"),
):
    t = _tts()
    if not name.strip():
        raise HTTPException(400, "El nombre de la voz no puede estar vacío")

    ext = Path(audio.filename or "recording.webm").suffix.lstrip(".").lower() or "webm"
    audio_data = await audio.read()
    if len(audio_data) < 1024:
        raise HTTPException(400, "La grabación es demasiado corta")

    import functools
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            functools.partial(
                t.save_cloned_voice,
                audio_data, name.strip(), ref_text.strip(), language, ext,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"Error al guardar la voz: {exc}")

    return result


@app.delete("/api/tts/voices/{voice_id:path}")
async def tts_delete_voice(voice_id: str):
    t = _tts()
    ok = t.delete_custom_voice(voice_id)
    if not ok:
        raise HTTPException(404, "Voz no encontrada o no se puede eliminar")
    return {"ok": True}


@app.get("/api/tts/preview/{voice_id:path}")
async def tts_preview_voice(voice_id: str):
    from fastapi.responses import FileResponse as FR
    t = _tts()
    ref_path = t.preview_voice_path(voice_id)
    if not ref_path or not ref_path.exists():
        raise HTTPException(404, "Audio de referencia no disponible")
    return FR(str(ref_path), media_type="audio/wav")


# Serve frontend static files — must be last
_frontend = Path(__file__).parent.parent / "renderer"
app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")

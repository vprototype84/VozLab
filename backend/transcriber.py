import asyncio
import os
import re
import threading
import time
from typing import AsyncGenerator, Dict, Any, List, Optional
from pathlib import Path

_model_cache: Dict[str, Any] = {}

# ── Prompts de calidad por idioma ────────────────────────────────────────────
_INITIAL_PROMPTS: Dict[str, str] = {
    "es": "Transcripción clara en español. Sin muletillas.",
    "ca": "Transcripció clara en català. Sense paraules de farciment.",
    "en": "Clear transcription in English. No filler words.",
}


def _get_initial_prompt(job: dict) -> Optional[str]:
    lang = job.get("language", "es")
    # Con detección automática no añadimos prompt (puede confundir al modelo)
    if lang == "auto":
        return None
    return _INITIAL_PROMPTS.get(lang, _INITIAL_PROMPTS["es"])


# ── Filtro de muletillas post-transcripción ───────────────────────────────────
# Solo disfluencias inequívocas (sonidos de duda aislados). NO se filtran palabras
# como "bueno", "a ver", "o sea", "digamos", "básicamente" o "literalmente": son
# válidas según el contexto ("bueno para la salud", "vamos a ver el partido",
# "o sea que…") y borrarlas mutaba el texto. La limpieza contextual de muletillas
# se delega en la acción "Limpiar" con IA (ollama_client.py).
_FILLERS_RE = re.compile(
    r'\b(eh+|em+|mm+|ah+|oh+|uh+|um+)\b',
    re.IGNORECASE,
)


def _clean_fillers(text: str) -> str:
    cleaned = _FILLERS_RE.sub("", text)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def _finalize_speakers(job: dict, segments: List[dict], put) -> List[dict]:
    """Si la detección de hablantes está activa, reescribe seg['speaker'] con diarización real."""
    if not job.get("diarize", True):
        return segments
    try:
        import diarizer
        if not diarizer.diarization_available():
            return segments

        result_box: Dict[str, Any] = {}

        def do_diarize():
            try:
                os.nice(5)  # menor prioridad de scheduler → UI y asyncio no quedan sin CPU
            except (AttributeError, OSError):
                pass
            result_box["turns"] = diarizer.diarize(job["audio_path"], job.get("num_speakers"))

        dt = threading.Thread(target=do_diarize, daemon=True)
        dt.start()

        # Transición suave 89→93 mientras el diarizador carga los modelos ONNX (~1-2 s)
        for step_pct in (89, 90, 91, 92, 93):
            if not dt.is_alive():
                break
            time.sleep(0.4)
            put({"status": "progress",
                 "message": "Iniciando identificación de hablantes…",
                 "progress": step_pct})

        # Progreso simulado 93→99% mientras sherpa-onnx procesa el audio.
        audio_dur = job.get("audio_duration", 0)
        estimated_diar_secs = (audio_dur * 0.18) if audio_dur > 0 else 30
        tick_sleep_diar = max(2.0, estimated_diar_secs / 8)  # 8 ticks de 1%
        diar_pct = 93
        while dt.is_alive():
            time.sleep(tick_sleep_diar)
            diar_pct = min(99, diar_pct + 1)
            put({"status": "progress", "message": "Identificando hablantes…", "progress": diar_pct})

        dt.join()
        turns = result_box.get("turns", [])
        if turns:
            diarizer.assign_speakers(segments, turns)
    except Exception:
        # La diarización nunca debe tumbar la transcripción.
        pass
    return segments


def _has_cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


# Nombres de modelo del frontend/historial que NO son identificadores válidos de
# faster-whisper. Se normalizan al cargar para no romper jobs antiguos y para
# corregir los valores rotos que enviaba el selector ("large-turbo*").
_MODEL_ALIASES: Dict[str, str] = {
    "large-turbo":    "large-v3-turbo",
    "large-turbo-q4": "large-v3-turbo",
    "large":          "large-v3",
    "turbo":          "large-v3-turbo",
}


def _normalize_model(name: Optional[str]) -> str:
    name = (name or "auto").strip()
    return _MODEL_ALIASES.get(name, name)


def _hardware_profile() -> Dict[str, Any]:
    """Perfil del equipo donde corre la app: device, VRAM (GB) y núcleos de CPU.

    Pensado para que la app se autoconfigure al distribuirla a otros PCs Windows:
    elige el mejor modelo/cuantización/batch según lo que haya disponible.
    """
    device = "cpu"
    vram_gb = 0.0
    if _has_cuda():
        device = "cuda"
        try:
            import torch
            props = torch.cuda.get_device_properties(0)
            vram_gb = props.total_memory / (1024 ** 3)
        except Exception:
            vram_gb = 0.0
    return {"device": device, "vram_gb": vram_gb, "cpu_count": os.cpu_count() or 2}


def _auto_plan(requested_model: Optional[str]) -> "tuple[str, str, int]":
    """Devuelve (model_name, compute_type, batch_size) según el hardware.

    - requested_model == "auto" (o vacío): selección 100% automática del modelo.
    - Si el usuario fuerza un modelo concreto, se respeta ese modelo pero la
      cuantización y el batch se siguen eligiendo según el hardware.
    """
    hw = _hardware_profile()
    requested = _normalize_model(requested_model)
    auto = (requested == "auto")

    if hw["device"] == "cuda":
        vram = hw["vram_gb"]
        if vram >= 5:
            model, compute, batch = "large-v3-turbo", "float16", 16
        elif vram >= 4:
            model, compute, batch = "large-v3-turbo", "float16", 8
        elif vram >= 3:
            model, compute, batch = "large-v3-turbo", "int8_float16", 4
        else:
            model, compute, batch = "small", "int8_float16", 4
    else:
        cores = hw["cpu_count"]
        if cores >= 8:
            model, compute, batch = "medium", "int8", 4
        elif cores >= 4:
            model, compute, batch = "small", "int8", 2
        else:
            model, compute, batch = "base", "int8", 1

    if not auto:
        model = requested  # respeta la elección del usuario; mantiene compute/batch del hw
    return model, compute, batch


# Velocidad aproximada de transcripción (× tiempo real) por modelo, usada solo
# para ritmar la barra de progreso simulada y estimar el tiempo restante.
_SPEED_CPU: Dict[str, float] = {
    "tiny": 8, "base": 6, "small": 4, "medium": 2,
    "large-v3": 1, "large-v3-turbo": 2.5,
}
_SPEED_CUDA: Dict[str, float] = {
    "tiny": 35, "base": 28, "small": 20, "medium": 12,
    "large-v3": 7, "large-v3-turbo": 22,
}


def _estimate_tx_secs(job: dict, use_cuda: bool) -> float:
    """Segundos estimados de transcripción según modelo y duración del audio."""
    audio_dur = job.get("audio_duration", 0) or 0
    if audio_dur <= 0:
        return 0.0
    # Resuelve el modelo efectivo (incluido "auto") como en la transcripción real.
    eff_model, _compute, _batch = _auto_plan(job.get("model_size"))
    table = _SPEED_CUDA if use_cuda else _SPEED_CPU
    speed = table.get(eff_model, 12 if use_cuda else 2)
    return audio_dur / speed


def _load_faster_whisper(model_size: str, compute_type: str, device: str, batch_size: int):
    """Carga (y cachea) el modelo; lo envuelve en BatchedInferencePipeline si batch>0."""
    cache_key = f"{model_size}:{device}:{compute_type}:b{batch_size}"
    if cache_key in _model_cache:
        return _model_cache[cache_key]
    from faster_whisper import WhisperModel
    model = WhisperModel(
        model_size,
        device=device,
        compute_type=compute_type,
        download_root=str(Path.home() / ".cache" / "whisper"),
    )
    engine = model
    if batch_size > 0:
        try:
            from faster_whisper import BatchedInferencePipeline
            engine = BatchedInferencePipeline(model=model)
        except Exception:
            engine = model  # fallback al modelo secuencial si no está disponible
    # Cota simple (evicción FIFO): evita acumular modelos en RAM/VRAM si el usuario
    # va cambiando de modelo. Se conservan las 2 configuraciones más recientes.
    while len(_model_cache) >= 2:
        _model_cache.pop(next(iter(_model_cache)))
    _model_cache[cache_key] = engine
    return engine


def _worker_faster_whisper(job: dict, put):
    """Transcripción con faster-whisper (CPU o CUDA según hardware disponible)."""
    use_cuda = _has_cuda()
    device = "cuda" if use_cuda else "cpu"
    model_size, compute_type, batch_size = _auto_plan(job.get("model_size"))

    put({"status": "loading",
         "message": "Cargando modelo Whisper" + (" (GPU)…" if use_cuda else "…"), "progress": 2})

    engine = _load_faster_whisper(model_size, compute_type, device, batch_size)

    put({"status": "progress", "message": "Analizando audio…", "progress": 8})

    lang = job["language"] if job["language"] != "auto" else None
    initial_prompt = _get_initial_prompt(job)

    transcribe_kwargs = dict(
        language=lang,
        beam_size=5,
        word_timestamps=False,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        initial_prompt=initial_prompt,
    )
    if batch_size > 0:
        # BatchedInferencePipeline procesa chunks de forma independiente
        # (sin condition_on_previous_text) → mucho más rápido en audios largos.
        transcribe_kwargs["batch_size"] = batch_size
    else:
        transcribe_kwargs["condition_on_previous_text"] = True

    segments_iter, info = engine.transcribe(job["audio_path"], **transcribe_kwargs)

    total = getattr(info, "duration", 0) or 0
    collected: List[dict] = []

    for seg in segments_iter:
        text = _clean_fillers(seg.text.strip())
        if not text:
            continue
        seg_data = {
            "id":      len(collected),
            "start":   round(seg.start, 2),
            "end":     round(seg.end, 2),
            "text":    text,
            "speaker": "Hablante 1",
        }
        collected.append(seg_data)
        pct = min(90, 8 + int((seg.end / total) * 82)) if total > 0 else 50
        put({"status": "segment", "segment": seg_data, "progress": pct})

    collected = _finalize_speakers(job, collected, put)
    put({"status": "completed", "segments": collected, "progress": 100})


async def transcribe_audio(job: dict) -> AsyncGenerator[Dict[str, Any], None]:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _put(event: dict):
        asyncio.run_coroutine_threadsafe(queue.put(event), loop).result(timeout=60)

    use_cuda = _has_cuda()

    # Estimaciones (única fuente de verdad para barra + temporizador del frontend).
    est_tx_secs = _estimate_tx_secs(job, use_cuda)
    job["_est_tx_secs"] = est_tx_secs
    audio_dur = job.get("audio_duration", 0) or 0
    est_diar_secs = (audio_dur * 0.18) if (audio_dur > 0 and job.get("diarize", True)) else 0.0

    def worker():
        try:
            _worker_faster_whisper(job, _put)
        except Exception as exc:
            try:
                _put({"status": "error", "message": str(exc)})
            except Exception:
                pass

    yield {
        "status": "started",
        "message": "Iniciando transcripción" + (" (GPU)…" if use_cuda else "…"),
        "progress": 0,
        "audio_duration": audio_dur,
        "est_tx_secs": round(est_tx_secs, 1),
        "est_diar_secs": round(est_diar_secs, 1),
    }

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=7200.0)
            yield event
            if event.get("status") in ("completed", "error"):
                break
        except asyncio.TimeoutError:
            yield {"status": "error", "message": "Tiempo de espera agotado (>2 h)"}
            break

    thread.join(timeout=15)

"""
meetingrec_win.py — captura audio del sistema + micrófono (+ pantalla opcional) en Windows.

Sustituye al binario Swift/ScreenCaptureKit (meetingrec.swift) de la versión
macOS. Usa WASAPI loopback (vía la librería 'soundcard', pura Python/ctypes,
sin necesidad de toolchain de compilación) para el audio de sistema y el
micrófono, y un proceso ffmpeg hijo (gdigrab) para el vídeo de pantalla.

Uso:   python meetingrec_win.py <ruta_base> [--video]
Escribe <ruta_base>_system.wav y <ruta_base>_mic.wav.
Con --video también escribe <ruta_base>_video_raw.mp4 (H.264, sin audio).

Protocolo de stdout (igual que la versión macOS, para que backend/main.py no
tenga que cambiar su parser de líneas):
  STARTED            — captura iniciada correctamente
  S <nivel 0-1>       — nivel de audio del sistema (~10 Hz)
  M <nivel 0-1>       — nivel de audio del micrófono (~10 Hz)
  PAUSED / RESUMED    — confirmación de pausa/reanudación
  NO_PERMISSION       — no se pudo acceder a los dispositivos de audio
  WRITE_ERROR <msg>   — error al escribir a disco

Control: a diferencia de macOS (señales SIGUSR1/SIGUSR2/SIGTERM), en Windows
no hay señales POSIX para procesos normales. Este script lee comandos de una
línea por stdin en un hilo de fondo: PAUSE / RESUME / STOP.

Códigos de salida: 0 = ok, 2 = sin permiso/dispositivo, 3 = otro error.
"""
import os
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

FFMPEG = os.environ.get("TRANSCRIPTORIA_FFMPEG", "ffmpeg")

SAMPLE_RATE = 48000
CHANNELS = 2
BLOCK_FRAMES = 1024

_paused = False
_stop = threading.Event()


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _rms_level(block) -> float:
    import numpy as np
    if block.size == 0:
        return 0.0
    rms = float(np.sqrt(np.mean(np.square(block))))
    return min(1.0, rms * 4.0)


class _WavWriter:
    """Escribe un stream de bloques float32 a un WAV PCM16, igual que AVAudioFile en macOS."""

    def __init__(self, path: Path, samplerate: int, channels: int):
        self._wav = wave.open(str(path), "wb")
        self._wav.setnchannels(channels)
        self._wav.setsampwidth(2)
        self._wav.setframerate(samplerate)
        self._lock = threading.Lock()

    def write(self, block) -> None:
        import numpy as np
        pcm16 = np.clip(block, -1.0, 1.0)
        pcm16 = (pcm16 * 32767.0).astype(np.int16)
        with self._lock:
            self._wav.writeframes(pcm16.tobytes())

    def close(self) -> None:
        with self._lock:
            self._wav.close()


def _capture_loop(tag: str, recorder, wav_writer: _WavWriter, last_emit: list) -> None:
    """tag: 'S' (sistema) o 'M' (micrófono). recorder: soundcard Recorder ya abierto."""
    while not _stop.is_set():
        block = recorder.record(numframes=BLOCK_FRAMES)
        if _stop.is_set():
            break
        now = time.time()
        if now - last_emit[0] > 0.1:  # ~10 Hz, suficiente para un medidor de nivel en UI
            last_emit[0] = now
            level = 0.0 if _paused else _rms_level(block)
            _emit(f"{tag} {level:.3f}")
        if not _paused:
            try:
                wav_writer.write(block)
            except Exception as exc:
                _emit(f"WRITE_ERROR {exc}")


def _stdin_control_thread(ffmpeg_proc) -> None:
    global _paused
    for raw in sys.stdin:
        cmd = raw.strip().upper()
        if cmd == "PAUSE":
            _paused = True
            _emit("PAUSED")
        elif cmd == "RESUME":
            _paused = False
            _emit("RESUMED")
        elif cmd == "STOP":
            _stop.set()
            if ffmpeg_proc and ffmpeg_proc.poll() is None:
                try:
                    ffmpeg_proc.communicate(input=b"q", timeout=10)
                except Exception:
                    ffmpeg_proc.kill()
            break


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("USAGE: meetingrec_win.py <base_path> [--video]\n")
        return 3

    base_path = sys.argv[1]
    video_mode = "--video" in sys.argv[2:]

    try:
        import soundcard as sc
    except Exception as exc:
        sys.stderr.write(f"NO_PERMISSION {exc}\n")
        return 2

    try:
        speaker = sc.default_speaker()
        loopback_mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        mic = sc.default_microphone()
    except Exception as exc:
        sys.stderr.write(f"NO_PERMISSION {exc}\n")
        return 2

    sys_wav = _WavWriter(Path(f"{base_path}_system.wav"), SAMPLE_RATE, CHANNELS)
    mic_wav = _WavWriter(Path(f"{base_path}_mic.wav"), SAMPLE_RATE, CHANNELS)

    ffmpeg_proc = None
    if video_mode:
        out_mp4 = f"{base_path}_video_raw.mp4"
        ffmpeg_proc = subprocess.Popen(
            [
                FFMPEG, "-y",
                "-f", "gdigrab", "-framerate", "30", "-i", "desktop",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                out_mp4,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    threading.Thread(target=_stdin_control_thread, args=(ffmpeg_proc,), daemon=True).start()

    try:
        with loopback_mic.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS, blocksize=BLOCK_FRAMES) as sys_rec, \
             mic.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS, blocksize=BLOCK_FRAMES) as mic_rec:

            _emit("STARTED")

            t_sys = threading.Thread(target=_capture_loop, args=("S", sys_rec, sys_wav, [0.0]), daemon=True)
            t_mic = threading.Thread(target=_capture_loop, args=("M", mic_rec, mic_wav, [0.0]), daemon=True)
            t_sys.start()
            t_mic.start()

            while not _stop.is_set():
                time.sleep(0.2)

            t_sys.join(timeout=5)
            t_mic.join(timeout=5)
    except Exception as exc:
        sys.stderr.write(f"STREAM_ERROR {exc}\n")
        sys_wav.close()
        mic_wav.close()
        return 3

    sys_wav.close()
    mic_wav.close()

    if ffmpeg_proc and ffmpeg_proc.poll() is None:
        try:
            ffmpeg_proc.communicate(input=b"q", timeout=10)
        except Exception:
            ffmpeg_proc.kill()

    return 0


if __name__ == "__main__":
    sys.exit(main())

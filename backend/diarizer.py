"""
Diarización de hablantes con sherpa-onnx (100% offline, sin token).

Expone:
  • diarization_available()        → bool (modelos presentes)
  • diarize(audio_path, num=None)   → [{"start", "end", "speaker"}] (segundos)
  • assign_speakers(segments, turns) → reescribe seg["speaker"] según solape

Los modelos viven en  models/diarization/  dentro del proyecto.
"""
import os

# Limitar ONNX Runtime a 2 hilos y usar espera pasiva (sleep en vez de spin-wait).
# Debe hacerse ANTES de importar numpy o sherpa_onnx porque OpenMP se inicializa
# al cargar la librería. Sin esto, sherpa-onnx satura todos los cores durante la
# diarización de audios largos.
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")

from pathlib import Path
from typing import List, Dict, Optional

from proc_utils import NO_WINDOW_KWARGS

# models/diarization está dos niveles por encima de backend/
_ROOT       = Path(__file__).parent.parent
_MODEL_DIR  = _ROOT / "models" / "diarization"
_SEG_MODEL  = _MODEL_DIR / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
_EMB_MODEL  = _MODEL_DIR / "speaker_embedding.onnx"

_diar_cache = {}

# Umbral de distancia coseno para el clustering de hablantes.
# Bajar = más estricto al fusionar → más hablantes detectados.
# Subir = más permisivo al fusionar → menos hablantes detectados.
# Incluido en la clave del cache para que un cambio aquí tome efecto sin reiniciar el servidor.
_THRESHOLD = 0.5


def diarization_available() -> bool:
    return _SEG_MODEL.exists() and _EMB_MODEL.exists()


def _ffmpeg_bin() -> str:
    return os.environ.get("TRANSCRIPTORIA_FFMPEG", "ffmpeg")


def _load_audio_16k_mono(audio_path: str):
    """Devuelve (samples float32 mono, sample_rate=16000). Convierte con ffmpeg si hace falta."""
    import numpy as np
    import soundfile as sf
    import subprocess
    import tempfile

    try:
        data, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    except Exception:
        data, sr = None, None

    needs_convert = (
        data is None
        or sr != 16000
        or (hasattr(data, "ndim") and data.ndim > 1)
    )

    if needs_convert:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        subprocess.run(
            [_ffmpeg_bin(), "-y", "-i", audio_path, "-ac", "1", "-ar", "16000", tmp.name],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **NO_WINDOW_KWARGS,
        )
        data, sr = sf.read(tmp.name, dtype="float32", always_2d=False)
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if hasattr(data, "ndim") and data.ndim > 1:
        data = data.mean(axis=1)

    return np.ascontiguousarray(data, dtype="float32"), sr


def _get_diarizer(num_speakers: Optional[int]):
    import sherpa_onnx

    n = num_speakers if num_speakers and num_speakers > 0 else -1
    # La clave incluye _THRESHOLD para que cambiar el umbral invalide el cache sin reiniciar.
    key = (n, _THRESHOLD)
    if key in _diar_cache:
        return _diar_cache[key]

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(_SEG_MODEL)
            ),
            num_threads=2,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(_EMB_MODEL),
            num_threads=2,
        ),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=n if n > 0 else -1,
            threshold=_THRESHOLD,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    diar = sherpa_onnx.OfflineSpeakerDiarization(config)
    _diar_cache[key] = diar
    return diar


_MAX_AUTO_SPEAKERS = 5


def diarize(audio_path: str, num_speakers: Optional[int] = None) -> List[Dict]:
    """Devuelve los turnos de habla: [{start, end, speaker}] en segundos."""
    if not diarization_available():
        return []

    samples, sr = _load_audio_16k_mono(audio_path)
    diar = _get_diarizer(num_speakers)
    result = diar.process(samples).sort_by_start_time()

    # Si el usuario no fijó el nº de hablantes y el auto-detect "explota" (20+),
    # re-ejecutar forzando num_clusters=_MAX_AUTO_SPEAKERS. La 2ª pasada reprocesa
    # todo el audio (sherpa-onnx no expone reclustering incremental), así que solo
    # se dispara ante una sobredetección clara, no por 1-2 hablantes de más: en
    # esos casos marginales capar a 5 apenas mejora y no compensa duplicar el
    # tiempo de diarización. `samples` ya está cargado, así que no se relee el audio.
    if num_speakers is None:
        unique = set(int(seg.speaker) for seg in result)
        if len(unique) > _MAX_AUTO_SPEAKERS + 2:
            diar_capped = _get_diarizer(_MAX_AUTO_SPEAKERS)
            result = diar_capped.process(samples).sort_by_start_time()

    turns: List[Dict] = []
    for seg in result:
        turns.append({
            "start":   round(float(seg.start), 2),
            "end":     round(float(seg.end), 2),
            "speaker": int(seg.speaker),
        })
    return turns


def assign_speakers(segments: List[Dict], turns: List[Dict]) -> List[Dict]:
    """
    A cada segmento de la transcripción le asigna el hablante cuyo turno
    solapa más con él. Reescribe seg["speaker"] = "Hablante N".
    Si no hay turnos, deja los segmentos como están.
    """
    if not turns:
        return segments

    for seg in segments:
        s_start = seg.get("start", 0.0)
        s_end   = seg.get("end", s_start)
        best_spk, best_overlap = None, 0.0
        for t in turns:
            overlap = min(s_end, t["end"]) - max(s_start, t["start"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_spk = t["speaker"]
        if best_spk is None:
            # Sin solape: usa el turno cuyo centro esté más cerca
            mid = (s_start + s_end) / 2
            best_spk = min(
                turns,
                key=lambda t: abs(((t["start"] + t["end"]) / 2) - mid),
            )["speaker"]
        seg["speaker"] = f"Hablante {best_spk + 1}"
    return segments

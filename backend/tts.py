"""
backend/tts.py — Motor TTS para Transcriptor IA (Windows)

Usa Chatterbox Multilingual (Resemble AI, licencia MIT) para síntesis multilingüe
con clonación de voz zero-shot — calidad comparable a ElevenLabs. Soporta español
(es, mapeado al finetune peninsular es-es) e inglés (en).
El modelo se descarga de HuggingFace la primera vez y se cachea en la carpeta
indicada por la variable de entorno HF_HOME (en producción,
%LOCALAPPDATA%\\TranscriptorIA\\models\\hf — ver electron/main.js), o en la caché
por defecto de HuggingFace Hub si HF_HOME no está definida (dev).

Las voces "predefined/" vienen empaquetadas con la app (solo lectura en
producción: Program Files), mientras que las voces "custom/" clonadas por el
usuario deben vivir en una carpeta donde sí se pueda escribir. Por eso se
separan dos raíces, igual que NARRAVOZ_VOICES_BUILTIN / NARRAVOZ_VOICES_USER
en el proyecto hermano NarraVoz:
  BUILTIN_VOICES_DIR (TRANSCRIPTORIA_VOICES_BUILTIN, solo lectura)
    predefined/   {es_female, es_male, en_female, en_male}/
      reference.wav
      meta.json   # {id, name, language, gender, ref_text}
  USER_VOICES_DIR (TRANSCRIPTORIA_VOICES_USER, %APPDATA%\\TranscriptorIA en producción)
    custom/       {slug}/
      reference.wav   # grabado por el usuario
      meta.json
En desarrollo (sin esas variables de entorno) ambas raíces caen por defecto
en voices/ dentro del repo, que ya contiene predefined/ y custom/.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from proc_utils import NO_WINDOW_KWARGS

_BASE = Path(__file__).parent.parent
_DEFAULT_VOICES_DIR = _BASE / "voices"

BUILTIN_VOICES_DIR = Path(os.environ.get("TRANSCRIPTORIA_VOICES_BUILTIN", str(_DEFAULT_VOICES_DIR)))
USER_VOICES_DIR = Path(os.environ.get("TRANSCRIPTORIA_VOICES_USER", str(_DEFAULT_VOICES_DIR)))
TMP_DIR = Path(os.environ.get("TRANSCRIPTORIA_TMP", str(_BASE / "tmp")))
FFMPEG = os.environ.get("TRANSCRIPTORIA_FFMPEG", "ffmpeg")

_ROOT_BY_CATEGORY = {"predefined": BUILTIN_VOICES_DIR, "custom": USER_VOICES_DIR}

(USER_VOICES_DIR / "custom").mkdir(parents=True, exist_ok=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)


# ── Carga lazy del modelo Chatterbox Multilingual ────────────────────────────

_tts_lock    = threading.Lock()  # protege el estado de carga del modelo
_gen_lock    = threading.Lock()  # serializa las inferencias (el modelo no es thread-safe)
_tts_engine  = None
_model_ready   = False
_model_loading = False
_model_error   = None


def _device() -> str:
    import torch
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# Repos de HuggingFace: el modelo multilingüe base de Chatterbox y el finetune
# dedicado de español de España (Single Language Pack de Resemble AI). El modelo
# base suena latino; el finetune es-ES aporta pronunciación y cadencia peninsular.
_BASE_REPO       = "ResembleAI/chatterbox"
_ES_ES_REPO      = "ResembleAI/Chatterbox-Multilingual-es-es"
_ES_ES_T3        = "t3_es_es.safetensors"
_ES_ES_S3GEN     = "s3gen_v3.pt"
_TOKENIZER_FILE  = "grapheme_mtl_merged_expanded_v1.json"


def _build_es_es_engine(device: str):
    """Carga Chatterbox con el finetune peninsular es-ES.

    Combina, usando las clases del paquete chatterbox instalado, los pesos del
    repo base (codificador de voz `ve.pt`, voz por defecto `conds.pt` y el
    tokenizer) con el T3 y el S3Gen del finetune es-ES. Replica el loader del
    Space oficial `ResembleAI/Chatterbox-Multilingual-TTS-es-es`: el T3 usa la
    config multilingüe (vocab 2454/8194, idéntica al checkpoint es-ES) y el
    S3Gen v3 se carga con strict=False (trae claves extra respecto al base).
    Devuelve un ChatterboxMultilingualTTS listo (mismo `.generate`/`.sr`).
    """
    import torch
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file as load_safetensors
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS, Conditionals
    from chatterbox.models.t3 import T3
    from chatterbox.models.t3.modules.t3_config import T3Config
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import MTLTokenizer
    from chatterbox.models.voice_encoder import VoiceEncoder

    map_location = torch.device("cpu") if device in ("cpu", "mps") else None

    ve_path    = hf_hub_download(_BASE_REPO, "ve.pt")
    tok_path   = hf_hub_download(_BASE_REPO, _TOKENIZER_FILE)
    t3_path    = hf_hub_download(_ES_ES_REPO, _ES_ES_T3)
    s3gen_path = hf_hub_download(_ES_ES_REPO, _ES_ES_S3GEN)
    try:
        conds_path = hf_hub_download(_BASE_REPO, "conds.pt")
    except Exception:
        conds_path = None

    ve = VoiceEncoder()
    ve.load_state_dict(torch.load(ve_path, map_location=map_location, weights_only=True))
    ve.to(device).eval()

    t3 = T3(T3Config.multilingual())
    t3_state = load_safetensors(t3_path)
    if "model" in t3_state.keys():
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    s3gen = S3Gen()
    s3gen.load_state_dict(
        torch.load(s3gen_path, map_location=map_location, weights_only=True),
        strict=False,
    )
    s3gen.to(device).eval()

    tokenizer = MTLTokenizer(tok_path)

    conds = None
    if conds_path:
        conds = Conditionals.load(conds_path, map_location=map_location).to(device)

    return ChatterboxMultilingualTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


def _load_model_thread():
    global _tts_engine, _model_ready, _model_loading, _model_error
    try:
        import warnings
        warnings.filterwarnings("ignore")
        device = _device()
        try:
            engine = _build_es_es_engine(device)
        except Exception as exc:
            # Fallback: modelo multilingüe base (acento latino) si el finetune
            # es-ES no se puede cargar, para que el narrador no quede inservible.
            print(f"[tts] Finetune es-ES no disponible ({exc}); usando modelo base.", flush=True)
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            engine = ChatterboxMultilingualTTS.from_pretrained(device=device)
        _tts_engine    = engine
        _model_ready   = True
        _model_loading = False
    except Exception as exc:
        import traceback
        print("[tts] Error cargando el modelo Chatterbox:", flush=True)
        traceback.print_exc()
        _model_error   = str(exc)
        _model_loading = False


def ensure_model_loaded():
    """Inicia la carga del modelo local si el motor activo es Chatterbox.

    Con ElevenLabs no hay modelo local que cargar, así que es un no-op.
    """
    import tts_settings
    if tts_settings.get_settings().get("engine") == "elevenlabs":
        return
    global _model_loading, _model_error
    with _tts_lock:
        if _model_ready or _model_loading:
            return
        # Reintentar tras un fallo transitorio (p. ej. corte de red durante la
        # descarga inicial de ~2 GB): el error no debe quedar cacheado para siempre.
        _model_error   = None
        _model_loading = True
    t = threading.Thread(target=_load_model_thread, daemon=True, name="chatterbox-loader")
    t.start()


def is_model_cached() -> bool:
    """True si los pesos de Chatterbox ya están descargados en la caché de HF.

    Comprobación barata (sin importar chatterbox/torch) para distinguir 'descargar
    por primera vez' de 'solo cargar en RAM' en el aviso de la interfaz. Respeta
    HF_HOME / HF_HUB_CACHE si están definidas (instalación empaquetada); si no, usa
    la caché por defecto de HuggingFace Hub (~/.cache/huggingface/hub).
    """
    hub_cache = os.environ.get("HF_HUB_CACHE")
    if hub_cache:
        hub = Path(hub_cache)
    else:
        hf_home = os.environ.get("HF_HOME")
        base = Path(hf_home) if hf_home else Path.home() / ".cache" / "huggingface"
        hub = base / "hub"
    if not hub.is_dir():
        return False
    # El finetune es-ES es la descarga grande (~2 GB); su snapshot no vacío en la
    # caché basta para considerar el modelo cacheado. Comparación case-insensitive
    # porque HF normaliza el nombre del repo en la carpeta de caché.
    for repo in hub.iterdir():
        if repo.name.lower().startswith("models--resembleai--chatterbox-multilingual-es-es"):
            snaps = repo / "snapshots"
            if snaps.is_dir() and any(s.is_dir() and any(s.iterdir()) for s in snaps.iterdir()):
                return True
    return False


def model_status() -> dict:
    import tts_settings
    s = tts_settings.get_settings()
    if s.get("engine") == "elevenlabs":
        configured = bool((s.get("elevenlabs_api_key") or "").strip())
        return {
            "engine":  "elevenlabs",
            "ready":   configured,
            "loading": False,
            "error":   None if configured else "Configura tu API key de ElevenLabs en el panel.",
            "cached":  True,
        }
    return {
        "engine":  "chatterbox",
        "ready":   _model_ready,
        "loading": _model_loading,
        "error":   _model_error,
        "cached":  is_model_cached(),
    }


# ── Catálogo de voces ─────────────────────────────────────────────────────────

def _read_meta(voice_dir: Path) -> Optional[dict]:
    meta_path = voice_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        if not (voice_dir / "reference.wav").exists():
            return None
        return meta
    except Exception:
        return None


def list_voices() -> dict:
    """Devuelve {predefined: [...], custom: [...]}"""
    result: dict = {"predefined": [], "custom": []}
    for category, root in _ROOT_BY_CATEGORY.items():
        cat_dir = root / category
        if not cat_dir.exists():
            continue
        for voice_dir in sorted(cat_dir.iterdir()):
            if not voice_dir.is_dir():
                continue
            meta = _read_meta(voice_dir)
            if meta:
                meta.setdefault("id", f"{category}/{voice_dir.name}")
                result[category].append(meta)
    return result


def get_voice_path(voice_id: str) -> Optional[Path]:
    parts = voice_id.split("/", 1)
    if len(parts) != 2 or parts[0] not in _ROOT_BY_CATEGORY:
        return None
    voice_dir = _ROOT_BY_CATEGORY[parts[0]] / parts[0] / parts[1]
    return voice_dir if voice_dir.is_dir() else None


def preview_voice_path(voice_id: str) -> Optional[Path]:
    vdir = get_voice_path(voice_id)
    if not vdir:
        return None
    ref = vdir / "reference.wav"
    return ref if ref.exists() else None


def delete_custom_voice(voice_id: str) -> bool:
    parts = voice_id.split("/", 1)
    if len(parts) != 2 or parts[0] != "custom":
        return False
    voice_dir = USER_VOICES_DIR / "custom" / parts[1]
    if not voice_dir.is_dir():
        return False
    # Si la voz tenía un clon en ElevenLabs, intentar borrarlo también para no
    # dejar huecos huérfanos en la cuenta (best-effort, no bloquea el borrado local).
    try:
        meta = _read_meta(voice_dir) or {}
        el_voice_id = meta.get("elevenlabs_voice_id")
        if el_voice_id:
            import tts_settings, elevenlabs_engine
            api_key = tts_settings.get_settings().get("elevenlabs_api_key", "")
            if api_key.strip():
                elevenlabs_engine.delete_voice(api_key, el_voice_id)
    except Exception:
        pass
    try:
        shutil.rmtree(voice_dir)
        return True
    except Exception:
        return False


# ── Clonación de voz ──────────────────────────────────────────────────────────

def _slugify(name: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", name.lower())
    slug = re.sub(r"[\s_-]+", "_", slug).strip("_")
    return slug or f"voice_{int(time.time())}"


def save_cloned_voice(
    audio_data: bytes,
    name: str,
    ref_text: str,
    language: str,
    audio_ext: str = "webm",
) -> dict:
    """
    Guarda un clip de audio grabado como voz clonada personalizada.
    Convierte a WAV 24 kHz mono (referencia válida para la clonación de Chatterbox).
    """
    slug = _slugify(name)
    voice_dir = USER_VOICES_DIR / "custom" / slug
    counter = 1
    while voice_dir.exists():
        voice_dir = USER_VOICES_DIR / "custom" / f"{slug}_{counter}"
        counter += 1
    voice_dir.mkdir(parents=True)

    raw_path = TMP_DIR / f"clone_raw_{uuid.uuid4()}.{audio_ext}"
    raw_path.write_bytes(audio_data)

    ref_wav = voice_dir / "reference.wav"
    result = subprocess.run(
        [FFMPEG, "-y", "-i", str(raw_path),
         "-ar", "24000", "-ac", "1", "-acodec", "pcm_s16le",
         str(ref_wav)],
        capture_output=True, **NO_WINDOW_KWARGS,
    )
    raw_path.unlink(missing_ok=True)

    if result.returncode != 0 or not ref_wav.exists():
        shutil.rmtree(voice_dir, ignore_errors=True)
        raise RuntimeError(
            f"Error al convertir el audio: {result.stderr.decode(errors='ignore')[-400:]}"
        )

    voice_id = f"custom/{voice_dir.name}"
    meta = {
        "id":       voice_id,
        "name":     name,
        "language": language,
        "gender":   "custom",
        "ref_text": ref_text,
    }
    (voice_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"voice_id": voice_id, "name": name}


def _clean_reference(voice_dir: Path) -> str:
    """Devuelve la ruta de la referencia "limpia" de una voz, generándola si hace falta.

    Chatterbox solo usa los primeros ~6 s del clip para el timbre (T3) y ~10 s
    para el decodificador (S3Gen). Un clip que empieza con silencio, con pausas
    largas, bajo de nivel o recortado da un embedding de locutor pobre y provoca
    errores y artefactos. `reference_clean.wav` se genera a partir de
    `reference.wav` con ffmpeg: filtro paso alto (ruido de baja frecuencia),
    recorte del silencio inicial/final, compresión de pausas internas a 0,25 s,
    normalización de sonoridad (-20 LUFS, pico -1,5 dB) y máximo 20 s.
    Se cachea junto a la voz y se regenera si `reference.wav` cambia.
    Si ffmpeg falla, se usa la referencia original tal cual.
    """
    raw = voice_dir / "reference.wav"
    clean = voice_dir / "reference_clean.wav"
    try:
        if clean.exists() and clean.stat().st_mtime >= raw.stat().st_mtime and clean.stat().st_size > 1000:
            return str(clean)
    except OSError:
        return str(raw)

    filters = ",".join([
        "highpass=f=60",
        "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB"
        ":stop_periods=-1:stop_silence=0.25:stop_threshold=-40dB",
        "loudnorm=I=-20:TP=-1.5:LRA=9",
        "atrim=0:20",
    ])
    tmp = TMP_DIR / f"refclean_{uuid.uuid4()}.wav"
    try:
        result = subprocess.run(
            [FFMPEG, "-y", "-i", str(raw), "-af", filters,
             "-ar", "24000", "-ac", "1", "-acodec", "pcm_s16le", str(tmp)],
            capture_output=True, **NO_WINDOW_KWARGS,
        )
        if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 1000:
            shutil.move(str(tmp), str(clean))
            return str(clean)
        print(f"[tts] No se pudo limpiar la referencia de {voice_dir.name}: "
              f"{result.stderr.decode(errors='ignore')[-300:]}", flush=True)
    except Exception as exc:
        print(f"[tts] No se pudo limpiar la referencia de {voice_dir.name}: {exc}", flush=True)
    finally:
        tmp.unlink(missing_ok=True)
    return str(raw)


# ── Perfiles de voz ───────────────────────────────────────────────────────────
# Cada perfil ajusta la expresividad de Chatterbox con sus mandos nativos:
#   - exaggeration: intensidad emocional/énfasis (0.5 por defecto; más alto = más
#     expresivo y dramático).
#   - cfg_weight: adherencia/ritmo (0.5 por defecto; más bajo = habla más pausada
#     y deliberada).
#   - temperature: variación/naturalidad (0.7-0.8 típico).
# "speed" NO es un parámetro de Chatterbox: se aplica después con ffmpeg (atempo),
# igual que antes. "normal" no aplica override (valores por defecto del modelo) y
# es el perfil por defecto.
PROFILES: dict = {
    "normal": {
        "name": "Normal",
        "description": "Voz neutra, como hasta ahora.",
        # temperature por debajo del 0.8 del modelo: menos errores y artefactos
        # sin perder naturalidad apreciable.
        "params": {"temperature": 0.65},
    },
    "cercana": {
        "name": "Cercana",
        "description": "Cálida y conversacional, como hablándole a un amigo.",
        "params": {"speed": 0.97, "exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.7},
    },
    "alegre": {
        "name": "Alegre",
        "description": "Enérgica y positiva, con más viveza.",
        "params": {"speed": 1.06, "exaggeration": 0.7, "cfg_weight": 0.5, "temperature": 0.8},
    },
    "profesional": {
        "name": "Profesional",
        "description": "Clara e informativa, tono controlado.",
        "params": {"speed": 1.00, "exaggeration": 0.35, "cfg_weight": 0.5, "temperature": 0.6},
    },
    "inspiradora": {
        "name": "Inspiradora",
        "description": "Pausada y motivacional, con énfasis.",
        "params": {"speed": 0.92, "exaggeration": 0.6, "cfg_weight": 0.4, "temperature": 0.7},
    },
    "calmada": {
        "name": "Calmada",
        "description": "Suave y relajada, ideal para bienestar.",
        "params": {"speed": 0.85, "exaggeration": 0.35, "cfg_weight": 0.4, "temperature": 0.6},
    },
    "dinamica": {
        "name": "Dinámica",
        "description": "Ágil y publicitaria, con gancho.",
        "params": {"speed": 1.10, "exaggeration": 0.7, "cfg_weight": 0.6, "temperature": 0.8},
    },
}
DEFAULT_PROFILE = "normal"

# Equivalencia de cada perfil en los `voice_settings` de ElevenLabs:
#   - stability (0-1): bajo = más expresivo/variable; alto = más estable/plano.
#   - similarity_boost (0-1): alto = más fiel al timbre clonado.
#   - style (0-1): exageración de estilo (alto = más expresivo).
#   - use_speaker_boost: refuerza la similitud con la voz original.
#   - speed (0.7-1.2): velocidad de habla (lo aplica el propio ElevenLabs).
_EL_PROFILE_SETTINGS: dict = {
    "normal":      {"stability": 0.50, "similarity_boost": 0.85, "style": 0.00, "use_speaker_boost": True, "speed": 1.00},
    "cercana":     {"stability": 0.45, "similarity_boost": 0.85, "style": 0.20, "use_speaker_boost": True, "speed": 0.98},
    "alegre":      {"stability": 0.35, "similarity_boost": 0.80, "style": 0.45, "use_speaker_boost": True, "speed": 1.06},
    "profesional": {"stability": 0.60, "similarity_boost": 0.90, "style": 0.10, "use_speaker_boost": True, "speed": 1.00},
    "inspiradora": {"stability": 0.40, "similarity_boost": 0.85, "style": 0.40, "use_speaker_boost": True, "speed": 0.95},
    "calmada":     {"stability": 0.65, "similarity_boost": 0.85, "style": 0.10, "use_speaker_boost": True, "speed": 0.90},
    "dinamica":    {"stability": 0.30, "similarity_boost": 0.80, "style": 0.50, "use_speaker_boost": True, "speed": 1.10},
}


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _stability_to_temperature(stability: float) -> float:
    """Slider 'Estabilidad' (0-1) → temperature de Chatterbox.

    Más estabilidad = menos variación de muestreo (temperature más baja).
    Rango resultante 0.5-1.0 (a stability=0.5 da 0.75, cerca del default 0.8).
    """
    return 1.0 - 0.5 * _clamp01(stability)


def _temperature_to_stability(temperature: float) -> float:
    """Inversa de `_stability_to_temperature`, para derivar el valor de slider
    de 'Estabilidad' que implica el `temperature` de un perfil existente."""
    return _clamp01(2.0 * (1.0 - temperature))


# Similarity <-> cfg_weight es una identidad (clamp 0-1 en ambos sentidos): no hay
# transformación, cfg_weight ya vive en el rango 0-1 que usa el slider.
def _similarity_to_cfg_weight(similarity: float) -> float:
    return _clamp01(similarity)


def _cfg_weight_to_similarity(cfg_weight: float) -> float:
    return _clamp01(cfg_weight)


def _generate_elevenlabs(job_id: str, settings: dict, voice_dir: Path, meta: dict,
                         text: str, profile_id: str, output_format: str,
                         speed: Optional[float] = None, stability: Optional[float] = None,
                         similarity: Optional[float] = None) -> Path:
    """Genera audio con ElevenLabs y devuelve la ruta del archivo final.

    Clona la voz (IVC) en la primera llamada y reutiliza el voice_id cacheado.
    ElevenLabs entrega MP3; si se pide WAV se convierte con ffmpeg. La velocidad
    la aplica ElevenLabs vía voice_settings, así que aquí no hace falta atempo.

    `speed`/`stability`/`similarity`, si vienen informados (sliders de la UI),
    sobreescriben los valores del perfil — son parámetros reales de la API de
    ElevenLabs, sin necesidad de aproximación.
    """
    import elevenlabs_engine
    api_key  = settings.get("elevenlabs_api_key", "")
    model_id = settings.get("elevenlabs_model", elevenlabs_engine.DEFAULT_MODEL)

    voice_id = elevenlabs_engine.get_or_create_voice(api_key, voice_dir, meta)
    voice_settings = dict(_EL_PROFILE_SETTINGS.get(profile_id, _EL_PROFILE_SETTINGS[DEFAULT_PROFILE]))
    if stability is not None:
        voice_settings["stability"] = _clamp01(stability)
    if similarity is not None:
        voice_settings["similarity_boost"] = _clamp01(similarity)
    if speed is not None:
        voice_settings["speed"] = max(0.7, min(1.2, speed))

    out_mp3 = TMP_DIR / f"tts_{job_id}.mp3"
    elevenlabs_engine.synthesize(api_key, model_id, voice_id, text, voice_settings, out_mp3)

    if output_format == "wav":
        out_wav = TMP_DIR / f"tts_{job_id}.wav"
        subprocess.run(
            [FFMPEG, "-y", "-i", str(out_mp3), "-acodec", "pcm_s16le", str(out_wav)],
            capture_output=True, check=True, **NO_WINDOW_KWARGS,
        )
        out_mp3.unlink(missing_ok=True)
        return out_wav
    return out_mp3


def list_profiles() -> list:
    """Lista de perfiles para la UI, incluyendo los valores de slider
    (velocidad/estabilidad/similitud) que implica cada perfil en cada motor —
    permite que el frontend rellene los sliders al elegir un perfil sin
    duplicar las fórmulas de conversión."""
    result = []
    for pid, p in PROFILES.items():
        cb_params = p["params"]
        el_params = _EL_PROFILE_SETTINGS.get(pid, _EL_PROFILE_SETTINGS[DEFAULT_PROFILE])
        result.append({
            "id": pid,
            "name": p["name"],
            "description": p["description"],
            "sliders": {
                "chatterbox": {
                    "speed":      cb_params.get("speed", 1.0),
                    "stability":  _temperature_to_stability(cb_params.get("temperature", 0.8)),
                    "similarity": _cfg_weight_to_similarity(cb_params.get("cfg_weight", 0.5)),
                },
                "elevenlabs": {
                    "speed":      el_params["speed"],
                    "stability":  el_params["stability"],
                    "similarity": el_params["similarity_boost"],
                },
            },
        })
    return result


# Longitud máxima (caracteres) por fragmento enviado a Chatterbox. El modelo
# degrada con textos largos (se acelera, se salta frases, mete artefactos al
# final), así que se trocea en frases y se concatena el audio resultante.
_TTS_MAX_CHARS = 220  # fragmentos más cortos = menos alucinaciones por fragmento
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…;:])\s+|\n+")


def _split_text(text: str, max_len: int = _TTS_MAX_CHARS) -> list:
    """Parte el texto en fragmentos ≤ max_len respetando límites de frase.

    Corta primero por final de frase (.!?…;: o saltos de línea). Si una frase
    supera max_len, la subdivide por comas y, en último caso, por espacios, para
    no exceder nunca demasiado el límite del modelo.
    """
    text = text.strip()
    if not text:
        return []

    def _hard_wrap(fragment: str) -> list:
        # Subdivide un fragmento demasiado largo por comas y luego por palabras.
        if len(fragment) <= max_len:
            return [fragment]
        pieces, buf = [], ""
        for part in re.split(r"(?<=,)\s+", fragment):
            for word in part.split(" "):
                candidate = f"{buf} {word}".strip()
                if len(candidate) > max_len and buf:
                    pieces.append(buf)
                    buf = word
                else:
                    buf = candidate
        if buf:
            pieces.append(buf)
        return pieces

    chunks, current = [], ""
    for sentence in _SENTENCE_SPLIT_RE.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        candidate = f"{current} {sentence}".strip()
        if len(candidate) <= max_len:
            current = candidate
        else:
            if current:
                chunks.append(current)
            if len(sentence) <= max_len:
                current = sentence
            else:
                # Frase enorme sin puntuación interna: trocear a la fuerza.
                hard = _hard_wrap(sentence)
                chunks.extend(hard[:-1])
                current = hard[-1] if hard else ""
    if current:
        chunks.append(current)
    return chunks


# Verificación de fragmentos con Whisper: cada trozo generado se transcribe y se
# compara con el texto pedido; si la tasa de error de caracteres supera el umbral
# se regenera (hasta _VERIFY_MAX_ATTEMPTS intentos) y se conserva el mejor.
# Detecta alucinaciones, palabras comidas y "ruidos raros" al final del fragmento.
_VERIFY_WITH_WHISPER = True
_VERIFY_CER_THRESHOLD = 0.10
_VERIFY_MAX_ATTEMPTS  = 3
_VERIFY_WHISPER_MODEL = "small"   # ligero: convive con Chatterbox en GPUs de 6 GB
_verify_model = None
_verify_lock  = threading.Lock()


def _normalize_for_cer(text: str, lang: str = "es") -> str:
    """Minúsculas, sin tildes ni puntuación, y con los números en letras
    (Whisper escribe "10" y "2027" aunque se haya dicho "diez" / "dos mil
    veintisiete"; sin esto la comparación daría falsos positivos)."""
    import unicodedata
    text = text.lower()
    try:
        from num2words import num2words
        def _words(m):
            n = int(m.group())
            # En inglés los años se leen "twenty twenty-seven", no "two thousand...".
            if lang == "en" and 1100 <= n <= 2099:
                return " " + num2words(n, lang=lang, to="year") + " "
            return " " + num2words(n, lang=lang) + " "
        text = re.sub(r"\d+", _words, text)
    except Exception:
        pass
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9ñ\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _cer(ref: str, hyp: str, lang: str = "es") -> float:
    """Tasa de error de caracteres (Levenshtein / len(ref)) sobre texto normalizado."""
    ref, hyp = _normalize_for_cer(ref, lang), _normalize_for_cer(hyp, lang)
    if not ref:
        return 0.0
    prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i]
        for j, hc in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / len(ref)


def _get_verify_model():
    global _verify_model
    with _verify_lock:
        if _verify_model is None:
            import transcriber
            device = _device()
            compute = "int8_float16" if device == "cuda" else "int8"
            _verify_model = transcriber._load_faster_whisper(
                _VERIFY_WHISPER_MODEL, compute, device, batch_size=0)
        return _verify_model


def _transcribe_chunk(wav, sr: int, language: str) -> str:
    """Transcribe un tensor (1, N) con Whisper; devuelve "" si algo falla."""
    try:
        import torchaudio.functional as F
        audio = F.resample(wav, sr, 16000)[0].numpy().astype("float32")
        segments, _ = _get_verify_model().transcribe(
            audio, language=language, beam_size=1, vad_filter=False,
            condition_on_previous_text=False)
        return " ".join(seg.text for seg in segments)
    except Exception as exc:
        print(f"[tts] Verificación Whisper no disponible: {exc}", flush=True)
        return ""


def _trim_trailing(wav, sr: int, threshold: float = 0.01, keep: float = 0.08):
    """Recorta el silencio/ruido de baja energía del final del fragmento.

    Chatterbox a veces deja una cola de silencio o residuo tras la última
    palabra; recortarla evita huecos largos y artefactos entre fragmentos.
    """
    import torch
    x = wav[0].abs()
    win = max(1, int(sr * 0.02))
    n = (x.numel() // win) * win
    if n == 0:
        return wav
    env = x[:n].view(-1, win).mean(dim=1)
    active = torch.nonzero(env > threshold)
    if active.numel() == 0:
        return wav
    end = min(wav.shape[1], (int(active[-1]) + 1) * win + int(sr * keep))
    return wav[:, :end]


def _infer_chatterbox(ref_audio: str, language: str, text: str, out_wav: Path,
                      params: Optional[dict] = None,
                      on_progress=None) -> None:
    """Síntesis con Chatterbox Multilingual usando una referencia de audio para
    clonación de voz zero-shot.

    `language` es el `language_id` de Chatterbox (p. ej. "es", "en").
    `params` puede traer exaggeration / cfg_weight / temperature (los manda el
    perfil de voz); las claves no soportadas se ignoran. Los textos largos se
    trocean en frases (ver `_split_text`); cada fragmento se verifica con
    Whisper (ver `_VERIFY_WITH_WHISPER`) y se regenera si no coincide con el
    texto, se le recorta la cola y se concatena con un breve silencio. La salida
    se escribe como WAV a la frecuencia nativa del modelo (model.sr); la
    conversión a mp3 y el ajuste de velocidad (atempo) los hace ffmpeg después.
    """
    import warnings
    warnings.filterwarnings("ignore")
    import torch
    import torchaudio as ta

    gen_kwargs = {}
    for key in ("exaggeration", "cfg_weight", "temperature"):
        if params and key in params:
            gen_kwargs[key] = params[key]

    chunks = _split_text(text) or [text]
    whisper_lang = "en" if language == "en" else "es"

    # El modelo no es thread-safe: serializar todas las inferencias locales.
    with _gen_lock:
        sr = _tts_engine.sr
        gap = torch.zeros(1, int(sr * 0.15))  # ~150 ms de silencio entre fragmentos
        wavs = []
        for i, chunk in enumerate(chunks):
            best_wav, best_cer = None, None
            attempts = _VERIFY_MAX_ATTEMPTS if _VERIFY_WITH_WHISPER else 1
            for attempt in range(attempts):
                wav = _tts_engine.generate(
                    text=chunk,
                    language_id=language,
                    audio_prompt_path=ref_audio,
                    **gen_kwargs,
                )
                if wav.dim() == 1:
                    wav = wav.unsqueeze(0)
                wav = _trim_trailing(wav.detach().cpu(), sr)
                if not _VERIFY_WITH_WHISPER:
                    best_wav = wav
                    break
                hyp = _transcribe_chunk(wav, sr, whisper_lang)
                if not hyp:
                    best_wav = wav   # sin verificación posible: aceptar
                    break
                cer = _cer(chunk, hyp, whisper_lang)
                if best_cer is None or cer < best_cer:
                    best_wav, best_cer = wav, cer
                if cer <= _VERIFY_CER_THRESHOLD:
                    break
                print(f"[tts] Fragmento {i+1}/{len(chunks)} intento {attempt+1}: "
                      f"CER {cer:.2f} > {_VERIFY_CER_THRESHOLD}, regenerando", flush=True)
            if i > 0:
                wavs.append(gap)
            wavs.append(best_wav)
            if on_progress:
                on_progress((i + 1) / len(chunks))

    final = wavs[0] if len(wavs) == 1 else torch.cat(wavs, dim=1)
    ta.save(str(out_wav), final, sr)


# Idiomas de salida ofrecidos en la UI → language_id de ChatterboxMultilingualTTS.
# El modelo multilingüe 0.1.7 expone "es" (español), no un id "es-es"; el acento
# peninsular lo aporta la voz de referencia (p. ej. "Sofía"), no el language_id.
# "en_es" = inglés con acento español (texto inglés pronunciado con la voz
# española → suena a español hablando inglés); internamente usa "es".
SUPPORTED_LANGUAGES = {"es", "en", "en_es"}
_UI_LANG_TO_CHATTERBOX = {"es": "es", "en": "en", "en_es": "es"}


tts_jobs: dict = {}

# Antigüedad máxima de un job/temporal TTS antes de purgarlo (segundos).
_TTS_JOB_TTL = 6 * 3600


def purge_old_jobs(ttl: int = _TTS_JOB_TTL) -> None:
    """Elimina jobs TTS antiguos y sus temporales para no acumular RAM/disco.

    Best-effort: se llama al crear un job nuevo. Borra las entradas de `tts_jobs`
    más viejas que `ttl` (junto con su archivo de salida) y, además, cualquier
    `tts_*` huérfano en TMP_DIR con esa antigüedad (p. ej. jobs perdidos tras un
    reinicio del backend). Nunca toca jobs recientes/en curso.
    """
    now = time.time()
    for jid in [j for j, v in tts_jobs.items()
                if now - v.get("created_at", now) > ttl]:
        job = tts_jobs.pop(jid, None)
        out = (job or {}).get("output_path")
        if out:
            try:
                Path(out).unlink(missing_ok=True)
            except OSError:
                pass
    try:
        for f in TMP_DIR.glob("tts_*"):
            try:
                if now - f.stat().st_mtime > ttl:
                    f.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass


def generate_speech(
    job_id: str,
    text: str,
    voice_id: str,
    output_format: str = "mp3",
    language: Optional[str] = None,
    profile: Optional[str] = None,
    speed: Optional[float] = None,
    stability: Optional[float] = None,
    similarity: Optional[float] = None,
) -> None:
    """
    Genera audio TTS de forma síncrona (ejecutar en un thread executor).
    Actualiza tts_jobs[job_id] con el estado y progreso.

    `speed`/`stability`/`similarity` son los sliders de la UI (0.7-1.2 / 0-1 / 0-1);
    si vienen informados sobreescriben los valores que traería el perfil elegido.
    Si son `None` (llamadas antiguas), se mantiene el 100% del comportamiento por perfil.
    """
    job = tts_jobs.get(job_id)
    if not job:
        return

    def _set(status=None, progress=None, error=None):
        if status:   job["status"]   = status
        if progress: job["progress"] = progress
        if error:    job["error"]    = error

    try:
        voice_dir = get_voice_path(voice_id)
        if not voice_dir:
            _set(status="error", error=f"Voz no encontrada: {voice_id}")
            return

        meta = _read_meta(voice_dir)
        if not meta:
            _set(status="error", error="Metadatos de voz no disponibles")
            return

        import tts_settings
        settings = tts_settings.get_settings()
        engine = settings.get("engine", "chatterbox")
        prof_id = profile if profile in PROFILES else DEFAULT_PROFILE

        # ── Motor en la nube: ElevenLabs ──────────────────────────────────────
        if engine == "elevenlabs":
            if not (settings.get("elevenlabs_api_key") or "").strip():
                _set(status="error",
                     error="Falta la API key de ElevenLabs. Configúrala en el panel del narrador.")
                return
            _set(status="generating", progress=20)
            out_final = _generate_elevenlabs(job_id, settings, voice_dir, meta, text, prof_id, output_format,
                                              speed=speed, stability=stability, similarity=similarity)
            job["progress"]      = 100
            job["status"]        = "completed"
            job["output_path"]   = str(out_final)
            job["output_format"] = output_format
            return

        # ── Motor local: Chatterbox ───────────────────────────────────────────
        ref_audio = _clean_reference(voice_dir)
        if language in SUPPORTED_LANGUAGES:
            out_language = _UI_LANG_TO_CHATTERBOX[language]
        else:
            out_language = meta.get("language", "es")

        prof = PROFILES[prof_id]
        prof_params = dict(prof["params"])
        out_speed = float(prof_params.pop("speed", 1.0))
        synth_params = prof_params

        # Los sliders de la UI, si vienen informados, ganan sobre el perfil para
        # velocidad/estabilidad/similitud; `exaggeration` sigue viniendo del perfil.
        if speed is not None:
            out_speed = max(0.7, min(1.2, speed))
        if stability is not None:
            synth_params["temperature"] = _stability_to_temperature(stability)
        if similarity is not None:
            synth_params["cfg_weight"] = _similarity_to_cfg_weight(similarity)

        if not _model_ready:
            ensure_model_loaded()
            _set(status="loading_model", progress=5)
            deadline = time.time() + 600  # 10 minutos máximo para descarga
            while not _model_ready and not _model_error and time.time() < deadline:
                time.sleep(2)
            if _model_error:
                _set(status="error", error=f"Error al cargar el modelo: {_model_error}")
                return
            if not _model_ready:
                _set(status="error", error="Tiempo de espera del modelo agotado")
                return

        _set(status="generating", progress=20)

        out_wav = TMP_DIR / f"tts_{job_id}.wav"
        _infer_chatterbox(ref_audio, out_language, text, out_wav, synth_params,
                          on_progress=lambda f: _set(progress=20 + int(f * 60)))

        _set(progress=80)

        af = [] if abs(out_speed - 1.0) < 0.01 else ["-filter:a", f"atempo={out_speed:.3f}"]

        if output_format == "mp3":
            out_final = TMP_DIR / f"tts_{job_id}.mp3"
            subprocess.run(
                [FFMPEG, "-y", "-i", str(out_wav), *af,
                 "-codec:a", "libmp3lame", "-q:a", "2",
                 str(out_final)],
                capture_output=True, check=True, **NO_WINDOW_KWARGS,
            )
            out_wav.unlink(missing_ok=True)
        elif af:
            out_final = TMP_DIR / f"tts_{job_id}_final.wav"
            subprocess.run(
                [FFMPEG, "-y", "-i", str(out_wav), *af,
                 "-acodec", "pcm_s16le", str(out_final)],
                capture_output=True, check=True, **NO_WINDOW_KWARGS,
            )
            out_wav.unlink(missing_ok=True)
        else:
            out_final = out_wav

        job["progress"]      = 100
        job["status"]        = "completed"
        job["output_path"]   = str(out_final)
        job["output_format"] = output_format

    except Exception as exc:
        _set(status="error", error=str(exc))

"""
backend/tts_settings.py — Preferencias del narrador (motor de voz + ElevenLabs).

Permite elegir entre el motor local (Chatterbox) y ElevenLabs (nube). Se guarda
en un JSON en una carpeta escribible y persistente entre actualizaciones:
%APPDATA%\\TranscriptorIA\\tts_settings.json en producción (el padre de
USER_VOICES_DIR), o en el repo en desarrollo.

La API key se guarda en claro en ese JSON local del usuario (igual que muchas
apps de escritorio). No se empaqueta con la app ni sale del equipo salvo hacia
la propia API de ElevenLabs.
"""

import json
import os
import threading
from pathlib import Path

from tts import USER_VOICES_DIR  # raíz escribible de voces del usuario
import elevenlabs_engine

_CONFIG_PATH = Path(
    os.environ.get("TRANSCRIPTORIA_SETTINGS", str(USER_VOICES_DIR.parent / "tts_settings.json"))
)
_lock = threading.Lock()

_DEFAULTS = {
    "engine": "chatterbox",              # "chatterbox" | "elevenlabs"
    "elevenlabs_api_key": "",
    "elevenlabs_model": elevenlabs_engine.DEFAULT_MODEL,
}


def _read() -> dict:
    data = dict(_DEFAULTS)
    try:
        if _CONFIG_PATH.exists():
            stored = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                data.update({k: stored[k] for k in _DEFAULTS if k in stored})
    except Exception:
        pass
    if data.get("engine") not in ("chatterbox", "elevenlabs"):
        data["engine"] = "chatterbox"
    if data.get("elevenlabs_model") not in elevenlabs_engine.SUPPORTED_MODELS:
        data["elevenlabs_model"] = elevenlabs_engine.DEFAULT_MODEL
    return data


def _write(data: dict) -> None:
    try:
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


def get_settings() -> dict:
    with _lock:
        return _read()


def update_settings(**changes) -> dict:
    """Actualiza solo las claves conocidas y devuelve el estado resultante."""
    with _lock:
        data = _read()
        for key in _DEFAULTS:
            if key in changes and changes[key] is not None:
                data[key] = changes[key]
        if data.get("engine") not in ("chatterbox", "elevenlabs"):
            data["engine"] = "chatterbox"
        if data.get("elevenlabs_model") not in elevenlabs_engine.SUPPORTED_MODELS:
            data["elevenlabs_model"] = elevenlabs_engine.DEFAULT_MODEL
        _write(data)
        return data


def public_settings() -> dict:
    """Estado para la UI — NO expone la API key, solo si está configurada."""
    data = get_settings()
    key = data.get("elevenlabs_api_key") or ""
    return {
        "engine": data["engine"],
        "elevenlabs": {
            "configured": bool(key.strip()),
            "key_hint": (key[:4] + "…" + key[-4:]) if len(key) >= 8 else "",
            "model": data["elevenlabs_model"],
            "models": elevenlabs_engine.SUPPORTED_MODELS,
        },
    }

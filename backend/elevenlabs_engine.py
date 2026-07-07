"""
backend/elevenlabs_engine.py — Motor TTS basado en la API de ElevenLabs.

Alternativa en la nube al motor local (Chatterbox). Da calidad y acento muy
superiores para español de España y clona el timbre con fidelidad (la limitación
que tiene el clonado local). Requiere una API key del usuario (plan Starter o
superior) y conexión a internet; se factura por créditos (≈ caracteres).

Clonado: usa Instant Voice Cloning (IVC) — sube el `reference.wav` de la voz una
sola vez vía POST /v1/voices/add y cachea el `voice_id` devuelto en el meta.json
de la voz (clave `elevenlabs_voice_id`). Las siguientes generaciones reutilizan
ese id sin volver a subir audio.

No usa SDK propio: llama a la API REST con httpx (ya es dependencia del backend).
"""

import json
from pathlib import Path
from typing import Optional

import httpx

_API_BASE = "https://api.elevenlabs.io/v1"
_TIMEOUT = httpx.Timeout(120.0, connect=15.0)

# Modelos soportados en la UI. multilingual_v2 = máxima calidad (1 crédito/char);
# turbo/flash v2.5 = más baratos (0,5 crédito/char) y casi tan buenos para español.
SUPPORTED_MODELS = {
    "eleven_multilingual_v2": "Multilingüe v2 (máxima calidad)",
    "eleven_turbo_v2_5": "Turbo v2.5 (mitad de créditos)",
    "eleven_flash_v2_5": "Flash v2.5 (más rápido y barato)",
}
DEFAULT_MODEL = "eleven_multilingual_v2"


class ElevenLabsError(RuntimeError):
    """Error legible para la UI (clave inválida, sin créditos, límite de voces…)."""


def _headers(api_key: str, accept: str = "application/json") -> dict:
    return {"xi-api-key": api_key, "accept": accept}


def _explain(resp: httpx.Response) -> str:
    """Extrae un mensaje de error útil del cuerpo de la respuesta de ElevenLabs."""
    try:
        data = resp.json()
        detail = data.get("detail", data)
        if isinstance(detail, dict):
            msg = detail.get("message") or detail.get("status") or json.dumps(detail)
        else:
            msg = str(detail)
    except Exception:
        msg = resp.text[:300]
    return f"ElevenLabs ({resp.status_code}): {msg}"


def validate_key(api_key: str) -> dict:
    """Comprueba que la API key es válida. Devuelve info básica de la cuenta.

    Lanza ElevenLabsError si la clave no es válida o no se puede contactar.
    """
    if not api_key or not api_key.strip():
        raise ElevenLabsError("Falta la API key de ElevenLabs.")
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.get(f"{_API_BASE}/user/subscription", headers=_headers(api_key))
    except httpx.HTTPError as exc:
        raise ElevenLabsError(f"No se pudo contactar con ElevenLabs: {exc}") from exc
    if resp.status_code == 401:
        raise ElevenLabsError("API key inválida o sin permisos.")
    if resp.status_code != 200:
        raise ElevenLabsError(_explain(resp))
    sub = resp.json()
    used = sub.get("character_count", 0)
    limit = sub.get("character_limit", 0)
    return {
        "tier": sub.get("tier", "—"),
        "characters_used": used,
        "characters_limit": limit,
        "characters_remaining": max(0, limit - used) if limit else None,
    }


def get_or_create_voice(api_key: str, voice_dir: Path, meta: dict) -> str:
    """Devuelve el voice_id de ElevenLabs para esta voz, creándolo si hace falta.

    Si el meta.json ya tiene `elevenlabs_voice_id`, lo reutiliza. Si no, sube el
    `reference.wav` como Instant Voice Clone, guarda el id en el meta.json y lo
    devuelve. Cachear el id evita re-subir el audio y consumir un hueco de voz
    por cada generación.
    """
    existing = meta.get("elevenlabs_voice_id")
    if existing:
        return existing

    ref = voice_dir / "reference.wav"
    if not ref.exists():
        raise ElevenLabsError("La voz no tiene audio de referencia (reference.wav).")

    name = meta.get("name") or voice_dir.name
    try:
        with httpx.Client(timeout=_TIMEOUT) as client, open(ref, "rb") as fh:
            resp = client.post(
                f"{_API_BASE}/voices/add",
                headers=_headers(api_key),
                data={
                    "name": f"TranscriptorIA · {name}",
                    "description": "Voz creada desde Transcriptor IA (clonado instantáneo).",
                },
                files={"files": (ref.name, fh, "audio/wav")},
            )
    except httpx.HTTPError as exc:
        raise ElevenLabsError(f"No se pudo subir la voz a ElevenLabs: {exc}") from exc
    if resp.status_code not in (200, 201):
        raise ElevenLabsError(_explain(resp))

    voice_id = resp.json().get("voice_id")
    if not voice_id:
        raise ElevenLabsError("ElevenLabs no devolvió un voice_id al crear la voz.")

    # Cachear el id en el meta.json de la voz (idempotente para futuras llamadas).
    meta["elevenlabs_voice_id"] = voice_id
    try:
        (voice_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        # Si no se puede escribir (voz predefinida de solo lectura en producción),
        # la voz seguirá funcionando esta sesión, solo se re-creará la próxima vez.
        pass
    return voice_id


def synthesize(
    api_key: str,
    model_id: str,
    voice_id: str,
    text: str,
    voice_settings: dict,
    out_mp3: Path,
) -> None:
    """Genera audio MP3 con ElevenLabs y lo escribe en out_mp3."""
    if model_id not in SUPPORTED_MODELS:
        model_id = DEFAULT_MODEL
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(
                f"{_API_BASE}/text-to-speech/{voice_id}",
                params={"output_format": "mp3_44100_128"},
                headers=_headers(api_key, accept="audio/mpeg"),
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise ElevenLabsError(f"Error de red al generar el audio: {exc}") from exc
    if resp.status_code != 200:
        raise ElevenLabsError(_explain(resp))
    out_mp3.write_bytes(resp.content)


def delete_voice(api_key: str, voice_id: str) -> None:
    """Borra una voz de la cuenta de ElevenLabs (best-effort, no lanza)."""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.delete(f"{_API_BASE}/voices/{voice_id}", headers=_headers(api_key))
    except httpx.HTTPError:
        pass

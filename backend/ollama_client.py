import json
import httpx
from typing import AsyncGenerator

OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_MODEL = "gemma4:e4b"

_SYSTEM = {
    "clean": (
        "Eres un editor de textos profesional en español. "
        "Limpia el texto transcrito que recibirás: elimina muletillas y palabras de relleno "
        "(eh, um, bueno, o sea, pues, ¿no?, etc.), corrige puntuación y ortografía, "
        "mejora la legibilidad. Mantén el contenido, tono y significado originales. "
        "No añadas información nueva. Devuelve únicamente el texto corregido."
    ),
    "summary": (
        "Eres un asistente profesional especializado en análisis de reuniones y conversaciones "
        "en español. Crea un resumen ejecutivo claro y estructurado en bullet points. "
        "Organiza por temas principales, incluye decisiones y conclusiones importantes. "
        "Usa formato Markdown con viñetas (- o •). Sé conciso pero completo."
    ),
    "minutes": (
        "Eres un asistente especializado en redacción de actas de reunión en español. "
        "Convierte el texto en un acta profesional usando exactamente este formato Markdown:\n\n"
        "# ACTA DE REUNIÓN\n\n"
        "**Fecha:** [infiere la fecha o escribe 'Sin especificar']\n"
        "**Participantes:** [lista los hablantes identificados]\n\n"
        "## TEMAS TRATADOS\n[subtítulos por cada tema principal]\n\n"
        "## ACUERDOS Y DECISIONES\n[lista los acuerdos tomados]\n\n"
        "## PRÓXIMOS PASOS\n[acciones a tomar, con responsables si se mencionan]\n\n"
        "## CIERRE\n[resumen breve del cierre]"
    ),
}

_USER = {
    "clean": "Limpia y mejora el siguiente texto transcrito:\n\n{text}",
    "summary": "Crea un resumen ejecutivo del siguiente texto:\n\n{text}",
    "minutes": "Convierte el siguiente texto en un acta de reunión formal:\n\n{text}",
}

ACTION_LABELS = {
    "clean": "Texto limpio",
    "summary": "Resumen ejecutivo",
    "minutes": "Acta de reunión",
}


async def process_with_ollama(text: str, action: str) -> AsyncGenerator[str, None]:
    system = _SYSTEM.get(action, _SYSTEM["clean"])
    user_msg = _USER.get(action, _USER["clean"]).format(text=text)

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=180.0) as client:
        async with client.stream(
            "POST", f"{OLLAMA_BASE_URL}/api/chat", json=payload
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    content = data.get("message", {}).get("content", "")
                    if content:
                        yield content
                    if data.get("done", False):
                        break
                except json.JSONDecodeError:
                    continue


async def check_ollama_available() -> bool:
    try:
        import urllib.request
        urllib.request.urlopen(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        return True
    except Exception:
        return False

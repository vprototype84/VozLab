import json
import asyncio
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional

TRANSCRIPTIONS_DIR = Path.home() / "Transcripciones"
TRANSCRIPTIONS_DIR.mkdir(exist_ok=True)

INDEX_PATH = TRANSCRIPTIONS_DIR / "index.json"


def _load_index() -> List[Dict]:
    if not INDEX_PATH.exists():
        return []
    try:
        with open(INDEX_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_index(index: List[Dict]) -> None:
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


async def save_to_history(job: dict, segments: List[Dict]) -> str:
    loop = asyncio.get_running_loop()

    def _save():
        duration = max((s["end"] for s in segments), default=0) if segments else 0
        metadata = {
            "id": job["id"],
            "filename": job.get("filename", "grabacion"),
            "date": datetime.now().isoformat(),
            "language": job.get("language", "es"),
            "segment_count": len(segments),
            "duration": round(duration, 1),
            "pinned": False,
        }
        full_data = {**metadata, "segments": segments}

        item_path = TRANSCRIPTIONS_DIR / f"{job['id']}.json"
        with open(item_path, "w", encoding="utf-8") as f:
            json.dump(full_data, f, ensure_ascii=False, indent=2)

        index = _load_index()
        index = [i for i in index if i["id"] != job["id"]]
        index.insert(0, metadata)
        _save_index(index)
        return job["id"]

    return await loop.run_in_executor(None, _save)


def _sorted_index(index: List[Dict]) -> List[Dict]:
    # Anclados primero; dentro de cada grupo se conserva el orden (recientes arriba).
    return sorted(index, key=lambda i: (not i.get("pinned", False),))


async def get_history() -> List[Dict]:
    try:
        loop = asyncio.get_running_loop()
        index = await loop.run_in_executor(None, _load_index)
    except RuntimeError:
        index = _load_index()
    return _sorted_index(index)


def _remove_audio(item_id: str) -> None:
    """Borra el audio temporal asociado (best-effort)."""
    try:
        import tempfile
        uploads = Path(tempfile.gettempdir()) / "transcriptor_uploads"
        for p in uploads.glob(f"{item_id}.*"):
            try:
                p.unlink()
            except OSError:
                pass
    except Exception:
        pass


async def delete_history_item(item_id: str) -> bool:
    def _delete():
        item_path = TRANSCRIPTIONS_DIR / f"{item_id}.json"
        if item_path.exists():
            try:
                item_path.unlink()
            except OSError:
                pass
        index = [i for i in _load_index() if i.get("id") != item_id]
        _save_index(index)
        _remove_audio(item_id)
        return True

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _delete)


async def delete_all_history() -> int:
    def _delete_all():
        index = _load_index()
        for i in index:
            item_path = TRANSCRIPTIONS_DIR / f"{i.get('id')}.json"
            if item_path.exists():
                try:
                    item_path.unlink()
                except OSError:
                    pass
            _remove_audio(i.get("id"))
        _save_index([])
        return len(index)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _delete_all)


async def set_pinned(item_id: str, pinned: bool) -> bool:
    def _set():
        index = _load_index()
        found = False
        for i in index:
            if i.get("id") == item_id:
                i["pinned"] = pinned
                found = True
                break
        if found:
            _save_index(index)
            # Reflejar también en el archivo individual.
            item_path = TRANSCRIPTIONS_DIR / f"{item_id}.json"
            if item_path.exists():
                try:
                    with open(item_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    data["pinned"] = pinned
                    with open(item_path, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass
        return found

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _set)


async def get_history_item(item_id: str) -> Optional[Dict]:
    def _load():
        item_path = TRANSCRIPTIONS_DIR / f"{item_id}.json"
        if not item_path.exists():
            return None
        with open(item_path, "r", encoding="utf-8") as f:
            return json.load(f)

    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _load)
    except RuntimeError:
        return _load()

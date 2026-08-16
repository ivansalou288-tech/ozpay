"""Панель OZPAY: API девайсов + статика мини-аппа.

Отдельный процесс от notify_server.py.
Проверки (check_balance / check_turnover / check_cards / full_check) идут в thread pool,
чтобы не блокировать event loop на ADB.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import SSL_CERTFILE, SSL_KEYFILE
from db_api import get_device, list_devices
from main import check_balance, check_cards, check_turnover, full_check

WEBAPP_DIR = Path(__file__).parent / "webapp"
PORT = 5001

CHECKERS = {
    "balance": check_balance,
    "turnover": check_turnover,
    "cards": check_cards,
    "all": full_check,
}

app = FastAPI(title="OZPAY Panel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_device_locks: dict[str, asyncio.Lock] = {}
_checking: set[str] = set()


def _lock_for(device_id: str) -> asyncio.Lock:
    lock = _device_locks.get(device_id)
    if lock is None:
        lock = asyncio.Lock()
        _device_locks[device_id] = lock
    return lock


def _to_number(value) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace("\xa0", " ").replace(" ", "").replace(",", ".")
    text = re.sub(r"[^\d.]", "", text)
    try:
        return float(text) if text else 0.0
    except ValueError:
        return 0.0


def _format_card_number(number: str) -> str:
    digits = re.sub(r"\D", "", number or "")
    if not digits:
        return number or ""
    return " ".join(digits[i:i + 4] for i in range(0, len(digits), 4))


def _format_expiry(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    if "/" in text:
        return text
    digits = re.sub(r"\D", "", text)
    if len(digits) == 4:
        month = int(digits[:2]) if digits[:2].isdigit() else 0
        if 1 <= month <= 12:
            return f"{digits[:2]}/{digits[2:]}"
    return text


def parse_cards(raw: Optional[str]) -> list[dict]:
    """cards в БД: number/expiry_or_last4/cvv, карты через ':'."""
    if not raw:
        return []
    cards = []
    for chunk in str(raw).split(":"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split("/")
        number = parts[0] if parts else ""
        middle = parts[1] if len(parts) > 1 else ""
        cvv = parts[2] if len(parts) > 2 else ""
        expiry = _format_expiry(middle)
        if not expiry and len(re.sub(r"\D", "", middle)) == 4:
            expiry = ""
        cards.append({
            "number": _format_card_number(number),
            "expiry": expiry,
            "cvv": cvv,
        })
    return cards


def serialize_device(row: dict) -> dict:
    device_id = row.get("device") or ""
    ip = row.get("ip")
    port = row.get("port")
    if device_id in _checking:
        status = "busy"
    elif ip and port:
        status = "online"
    else:
        status = "offline"

    return {
        "id": device_id,
        "name": row.get("name") or device_id,
        "number": row.get("number") or "",
        "status": status,
        "balance": _to_number(row.get("balance")),
        "income": _to_number(row.get("income")),
        "outcome": _to_number(row.get("outcome")),
        "cards": parse_cards(row.get("cards")),
    }


def _require_device(device_id: str) -> dict:
    row = get_device(device_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Устройство '{device_id}' не найдено")
    return row


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/devices")
async def api_list_devices() -> dict:
    return {"devices": [serialize_device(row) for row in list_devices()]}


@app.get("/api/devices/{device_id}")
async def api_get_device(device_id: str) -> dict:
    return {"device": serialize_device(_require_device(device_id))}


@app.post("/api/devices/{device_id}/check/{kind}")
async def api_check_device(device_id: str, kind: str) -> dict:
    if kind not in CHECKERS:
        raise HTTPException(status_code=400, detail="Неизвестный тип проверки")

    _require_device(device_id)
    lock = _lock_for(device_id)

    async with lock:
        _checking.add(device_id)
        try:
            await asyncio.to_thread(CHECKERS[kind], device_id)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        finally:
            _checking.discard(device_id)

    return {"device": serialize_device(_require_device(device_id))}


app.mount("/", StaticFiles(directory=WEBAPP_DIR, html=True), name="webapp")


if __name__ == "__main__":
    import uvicorn

    kwargs = {"host": "0.0.0.0", "port": PORT, "reload": False}

    cert = Path(SSL_CERTFILE) if SSL_CERTFILE else None
    key = Path(SSL_KEYFILE) if SSL_KEYFILE else None
    if cert and key and cert.exists() and key.exists():
        kwargs["ssl_certfile"] = str(cert)
        kwargs["ssl_keyfile"] = str(key)

    uvicorn.run("panel_server:app", **kwargs)

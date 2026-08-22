"""Панель OZPAY: API девайсов + статика мини-аппа.

Отдельный процесс от notify_server.py.
Проверки (check_balance / check_turnover / check_cards / full_check) идут в thread pool,
чтобы не блокировать event loop на ADB.
"""

from __future__ import annotations

import asyncio
import json
import queue
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import SSL_CERTFILE, SSL_KEYFILE
from db_api import create_device, delete_device, find_device_by_ip_port, get_device, list_devices, update_card_flags, update_password
from main import add_device, check_balance, check_cards, check_login_state, check_turnover, full_check, logout_lk, probe_adb

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

api = APIRouter(prefix="/api")

_device_locks: dict[str, asyncio.Lock] = {}
_checking: set[str] = set()

# Активные сессии входа в ЛК (device_id -> LoginSession).
_login_sessions: dict[str, "LoginSession"] = {}
_ACTIVE_LOGIN_STATES = {"running", "awaiting_code", "verifying"}
CODE_WAIT_TIMEOUT = 300.0


class LoginSession:
    """Интерактивная сессия входа: add_device выполняется в отдельном потоке и на
    шаге ввода кода блокируется, ожидая действие из мини-аппа (код или повторную
    отправку). Пока ждём код, поток сам опрашивает состояние кнопки 'Получить новый
    код' на устройстве и кладёт его в `resend_available`, чтобы кнопка в панели
    была активна ровно тогда же, когда она активна в Ozon."""

    def __init__(self, device_id: str, number: str, password: str):
        self.device_id = device_id
        self.number = number
        self.password = password
        self.status = "running"  # running | awaiting_code | verifying | done | error
        self.method: Optional[str] = None
        self.target: Optional[str] = None
        self.error: Optional[str] = None
        self.device: Optional[dict] = None
        self.resend_available = False
        self._device = None  # ppadb device, выдаётся add_device на шаге кода
        self._action_q: "queue.Queue[tuple]" = queue.Queue()
        self.thread: Optional[threading.Thread] = None

    def _update_resend_available(self):
        if self._device is None:
            return
        try:
            from main import _get_new_code_button_enabled
            state = _get_new_code_button_enabled(self._device)
            if state is not None:
                self.resend_available = bool(state)
        except Exception:
            pass

    def _perform_resend(self):
        if self._device is None:
            return
        try:
            from main import detect_code_screen, dismiss_permission_dialog, wait_and_tap_get_new_code
            self.resend_available = False
            wait_and_tap_get_new_code(self._device, timeout=10.0)
            dismiss_permission_dialog(self._device)
            time.sleep(1.0)
            hint = detect_code_screen(self._device) or {}
            self.method = hint.get("method")
            self.target = hint.get("target")
        except Exception:
            pass

    def code_provider(self, ctx=None):
        ctx = ctx or {}
        self._device = ctx.get("device")
        hint = ctx.get("hint")
        if hint is None and ("method" in ctx or "target" in ctx):
            hint = ctx  # совместимость: ctx уже является хинтом
        hint = hint or {}
        self.method = hint.get("method")
        self.target = hint.get("target")
        self.status = "awaiting_code"

        deadline = time.time() + CODE_WAIT_TIMEOUT
        while time.time() < deadline:
            self._update_resend_available()
            try:
                action, payload = self._action_q.get(timeout=2.0)
            except queue.Empty:
                continue
            if action == "code":
                self.status = "verifying"
                return payload
            if action == "resend":
                self._perform_resend()
                deadline = time.time() + CODE_WAIT_TIMEOUT
        raise RuntimeError("Код не был введён вовремя")

    def submit_code(self, code: str):
        self._action_q.put(("code", code))

    def request_resend(self):
        self._action_q.put(("resend", None))


def _run_login(session: LoginSession):
    try:
        add_device(
            session.device_id,
            session.number,
            session.password,
            code_provider=session.code_provider,
            press_get_new_code=False,
        )
        session.device = serialize_device(_require_device(session.device_id))
        session.status = "done"
    except Exception as exc:  # noqa: BLE001 — прокидываем текст ошибки в UI
        session.error = str(exc)
        session.status = "error"
    finally:
        _checking.discard(session.device_id)


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
    if re.fullmatch(r"(0[1-9]|1[0-2])/\d{2}(?:\d{2})?", text):
        return text[:5] if len(text) > 5 else text
    digits = re.sub(r"\D", "", text)
    if len(digits) == 4:
        month = int(digits[:2]) if digits[:2].isdigit() else 0
        if 1 <= month <= 12:
            return f"{digits[:2]}/{digits[2:]}"
    return ""


def parse_card_flags(raw) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        data = raw
    else:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    if not isinstance(data, dict):
        return {}
    flags = {}
    for key, value in data.items():
        digits = re.sub(r"\D", "", str(key))
        if not digits or not isinstance(value, dict):
            continue
        flags[digits] = {
            "beeline": bool(value.get("beeline")),
            "yapay": bool(value.get("yapay")),
        }
    return flags


def parse_cards(raw: Optional[str], flags_raw=None) -> list[dict]:
    """cards в БД: number/expiry/cvv, карты через ':'. Старый формат: number/last4/cvv."""
    flags_map = parse_card_flags(flags_raw)
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
        number_digits = re.sub(r"\D", "", number)
        middle_digits = re.sub(r"\D", "", middle)
        if number_digits and middle_digits == number_digits[-4:]:
            expiry = ""
        else:
            expiry = _format_expiry(middle)
        flags = flags_map.get(number_digits) or {}
        cards.append({
            "number": _format_card_number(number),
            "expiry": expiry,
            "cvv": cvv,
            "beeline": bool(flags.get("beeline")),
            "yapay": bool(flags.get("yapay")),
        })
    return cards


def serialize_device(row: dict) -> dict:
    device_id = row.get("device") or ""
    ip = row.get("ip")
    port = row.get("port")
    linked = bool(row.get("number"))
    blocked = bool(row.get("blocked"))
    if device_id in _checking:
        status = "busy"
    elif not linked:
        status = "new"
    elif blocked:
        status = "blocked"
    elif ip and port:
        status = "online"
    else:
        status = "offline"

    return {
        "id": device_id,
        "name": (row.get("name") or "").strip(),
        "number": row.get("number") or "",
        "ip": ip or "",
        "port": port if port not in (None, "") else "",
        "status": status,
        "linked": linked,
        "blocked": blocked,
        "checking": device_id in _checking,
        "balance": _to_number(row.get("balance")),
        "income": _to_number(row.get("income")),
        "outcome": _to_number(row.get("outcome")),
        "cards": parse_cards(row.get("cards"), row.get("card_flags")),
    }


_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _require_device(device_id: str) -> dict:
    row = get_device(device_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Устройство '{device_id}' не найдено")
    return row


@app.middleware("http")
async def log_requests(request: Request, call_next):
    if request.method == "OPTIONS":
        origin = request.headers.get("origin", "*")
        from fastapi.responses import Response
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Accept, Content-Type",
                "Access-Control-Max-Age": "86400",
                "Vary": "Origin",
            },
        )
    response = await call_next(request)
    origin = request.headers.get("origin")
    response.headers["Access-Control-Allow-Origin"] = origin or "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Accept, Content-Type"
    response.headers["Vary"] = "Origin"
    print(f"{request.method} {request.url.path} -> {response.status_code}")
    return response


@api.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@api.get("/devices")
async def api_list_devices() -> dict:
    try:
        rows = list_devices()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ошибка БД: {exc}") from exc
    return {"devices": [serialize_device(row) for row in rows]}


@api.post("/devices")
async def api_create_device(request: Request) -> dict:
    body = await request.json()
    device_id = (body.get("id") or body.get("device") or body.get("name") or "").strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Укажите имя девайса")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", device_id):
        raise HTTPException(status_code=400, detail="Имя девайса: латиница, цифры, . _ -")

    ip = (str(body.get("ip") or "")).replace(",", ".").strip()
    if not ip:
        raise HTTPException(status_code=400, detail="Укажите IP")

    port_raw = body.get("port")
    if port_raw in (None, ""):
        raise HTTPException(status_code=400, detail="Укажите порт")
    try:
        port = int(str(port_raw).strip())
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Порт должен быть числом")

    duplicate = find_device_by_ip_port(ip, port)
    if duplicate:
        raise HTTPException(
            status_code=409,
            detail=f"IP {ip}:{port} уже занят девайсом '{duplicate.get('device')}'",
        )

    try:
        await asyncio.to_thread(probe_adb, ip, port)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        create_device(device_id, ip=ip, port=port)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"Девайс '{device_id}' уже есть")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Не удалось создать девайс: {exc}") from exc

    return {"device": serialize_device(_require_device(device_id))}


@api.get("/devices/{device_id}")
async def api_get_device(device_id: str) -> dict:
    return {"device": serialize_device(_require_device(device_id))}


@api.delete("/devices/{device_id}")
async def api_delete_device(device_id: str) -> dict:
    _require_device(device_id)
    if device_id in _checking:
        raise HTTPException(status_code=409, detail="Дождитесь окончания проверки")
    if not delete_device(device_id):
        raise HTTPException(status_code=500, detail="Не удалось удалить девайс")
    return {"ok": True, "id": device_id}


@api.post("/devices/{device_id}/logout")
async def api_logout_device(device_id: str) -> dict:
    row = _require_device(device_id)
    if device_id in _checking:
        raise HTTPException(status_code=409, detail="Девайс уже проверяется")
    if not row.get("number"):
        raise HTTPException(status_code=400, detail="ЛК не привязан")

    _checking.add(device_id)
    lock = _lock_for(device_id)
    try:
        async with lock:
            await asyncio.to_thread(logout_lk, device_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        _checking.discard(device_id)

    return {"device": serialize_device(_require_device(device_id))}


@api.post("/devices/{device_id}/cards/flags")
async def api_update_card_flags(device_id: str, request: Request) -> dict:
    _require_device(device_id)
    body = await request.json()
    number = re.sub(r"\D", "", str(body.get("number") or ""))
    if not number:
        raise HTTPException(status_code=400, detail="Укажите номер карты")

    row = get_device(device_id)
    flags = parse_card_flags(row.get("card_flags") if row else None)
    current = flags.get(number) or {"beeline": False, "yapay": False}
    if "beeline" in body:
        current["beeline"] = bool(body.get("beeline"))
    if "yapay" in body:
        current["yapay"] = bool(body.get("yapay"))
    if current["beeline"] or current["yapay"]:
        flags[number] = current
    else:
        flags.pop(number, None)

    if not update_card_flags(device_id, json.dumps(flags, ensure_ascii=False)):
        raise HTTPException(status_code=500, detail="Не удалось сохранить флаги карты")
    return {"device": serialize_device(_require_device(device_id))}


@api.post("/devices/{device_id}/check/{kind}")
async def api_check_device(device_id: str, kind: str) -> dict:
    if kind not in CHECKERS:
        raise HTTPException(status_code=400, detail="Неизвестный тип проверки")

    _require_device(device_id)
    if device_id in _checking:
        raise HTTPException(status_code=409, detail="Девайс уже проверяется")

    _checking.add(device_id)
    lock = _lock_for(device_id)
    try:
        async with lock:
            await asyncio.to_thread(CHECKERS[kind], device_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        _checking.discard(device_id)

    return {"device": serialize_device(_require_device(device_id))}


@api.post("/devices/{device_id}/login")
async def api_login_start(device_id: str, request: Request) -> dict:
    _require_device(device_id)

    body = await request.json()
    number = re.sub(r"\D", "", str(body.get("number") or ""))
    password = re.sub(r"\D", "", str(body.get("password") or ""))
    if not number:
        raise HTTPException(status_code=400, detail="Укажите номер телефона")
    if not password:
        raise HTTPException(status_code=400, detail="Укажите пароль (код-пароль)")

    existing = _login_sessions.get(device_id)
    if existing and existing.status in _ACTIVE_LOGIN_STATES:
        raise HTTPException(status_code=409, detail="Вход уже выполняется")
    if device_id in _checking:
        raise HTTPException(status_code=409, detail="Девайс занят проверкой")

    session = LoginSession(device_id, number, password)
    _login_sessions[device_id] = session
    _checking.add(device_id)
    session.thread = threading.Thread(target=_run_login, args=(session,), daemon=True)
    session.thread.start()
    return {"status": session.status}


@api.get("/devices/{device_id}/login")
async def api_login_status(device_id: str) -> dict:
    session = _login_sessions.get(device_id)
    if not session:
        return {"status": "idle"}
    payload = {
        "status": session.status,
        "method": session.method,
        "target": session.target,
        "resend_available": session.resend_available,
    }
    if session.status == "error":
        payload["error"] = session.error
    if session.status == "done" and session.device:
        payload["device"] = session.device
    return payload


@api.post("/devices/{device_id}/login/code")
async def api_login_code(device_id: str, request: Request) -> dict:
    session = _login_sessions.get(device_id)
    if not session or session.status != "awaiting_code":
        raise HTTPException(status_code=409, detail="Сейчас код не ожидается")

    body = await request.json()
    code = re.sub(r"\D", "", str(body.get("code") or ""))
    if len(code) != 6:
        raise HTTPException(status_code=400, detail="Код должен состоять из 6 цифр")

    session.submit_code(code)
    return {"status": "verifying"}


@api.post("/devices/{device_id}/login/resend")
async def api_login_resend(device_id: str) -> dict:
    session = _login_sessions.get(device_id)
    if not session or session.status != "awaiting_code":
        raise HTTPException(status_code=409, detail="Сейчас код не ожидается")
    if not session.resend_available:
        raise HTTPException(status_code=409, detail="Кнопка ещё не активна")
    session.request_resend()
    return {"status": "awaiting_code"}


@api.post("/devices/{device_id}/login/refresh")
async def api_login_refresh(device_id: str) -> dict:
    _require_device(device_id)
    if device_id in _checking:
        raise HTTPException(status_code=409, detail="Девайс занят")
    try:
        state = await asyncio.to_thread(check_login_state, device_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return state


@api.post("/devices/{device_id}/password")
async def api_update_password(device_id: str, request: Request) -> dict:
    _require_device(device_id)
    body = await request.json()
    password = re.sub(r"\D", "", str(body.get("password") or ""))
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="Код-пароль: минимум 4 цифры")
    if not update_password(device_id, password):
        raise HTTPException(status_code=500, detail="Не удалось сохранить пароль")
    return {"ok": True, "id": device_id}


app.include_router(api)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEBAPP_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEBAPP_DIR), name="webapp")


if __name__ == "__main__":
    import uvicorn

    kwargs = {"host": "0.0.0.0", "port": PORT, "reload": False}

    cert = Path(SSL_CERTFILE) if SSL_CERTFILE else None
    key = Path(SSL_KEYFILE) if SSL_KEYFILE else None
    if cert and key and cert.exists() and key.exists():
        kwargs["ssl_certfile"] = str(cert)
        kwargs["ssl_keyfile"] = str(key)

    uvicorn.run("panel_server:app", **kwargs)

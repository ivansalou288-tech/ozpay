import asyncio
import html
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from aiogram import Bot, Dispatcher
from aiogram.enums import ParseMode
from aiogram.client.default import DefaultBotProperties
from aiogram.types import CopyTextButton, InlineKeyboardButton, InlineKeyboardMarkup

from config import BOT_TOKEN, DEVICE_CHAT_MAP, SSL_CERTFILE, SSL_KEYFILE
from db_api import get_device
from pars import parse_message

BALANCE_REFRESH_DELAY_SEC = 15


def _format_db_balance(balance) -> str:
    if balance is None or balance == "":
        return "—"
    try:
        value = float(balance)
    except (TypeError, ValueError):
        return html.escape(str(balance))
    if value.is_integer():
        formatted = f"{int(value):,}".replace(",", " ")
    else:
        formatted = f"{value:,.2f}".replace(",", " ")
    return f"{formatted} ₽"


def format_notification_message(
    message: str,
    *,
    account_name: Optional[str] = None,
    balance=None,
) -> tuple[str, Optional[InlineKeyboardMarkup]]:
    parsed = parse_message(message)
    code = parsed.get("code")
    amount = parsed.get("amount")
    service = parsed.get("service")

    lines = []
    if code:
        lines.append(f"<tg-emoji emoji-id='5775887550262546277'>❗️</tg-emoji> <b>Код:</b> <code>{code}</code>")
        lk_name = (account_name or "").strip() or "—"
        lines.append(f"<tg-emoji emoji-id='5879770735999717115'>👤</tg-emoji> <b>ЛК:</b> {html.escape(lk_name)}")
        lines.append(
            f"<tg-emoji emoji-id='6039641775377748623'>👛</tg-emoji> <b>Баланс:</b> {_format_db_balance(balance)}"
        )
    if amount:
        lines.append(f"<tg-emoji emoji-id='5769403330761593044'>👛</tg-emoji> <b>Сумма:</b> {amount} ₽")
    if service:
        lines.append(f"<tg-emoji emoji-id='5879585266426973039'>🌐</tg-emoji> <b>Сервис:</b> {service}")

    lines.append("")
    lines.append("<tg-emoji emoji-id='5956561916573782596'>📄</tg-emoji> <b>Полный текст уведомления:</b>")
    lines.append(html.escape(message))

    text = "\n".join(lines)

    markup = None
    if code:
        markup = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="Скопировать код",
                        copy_text=CopyTextButton(text=code),
                        icon_custom_emoji_id="5985774024968379294",
                        style="success",
                    )
                ]
            ]
        )

    return text, markup


async def refresh_balance_later(device_name: str) -> None:
    await asyncio.sleep(BALANCE_REFRESH_DELAY_SEC)
    try:
        from main import check_balance

        await asyncio.to_thread(check_balance, device_name)
        print(f"Balance refreshed for '{device_name}' after code redirect")
    except Exception as exc:
        print(f"Failed to refresh balance for '{device_name}': {exc}")


class NotifyRequest(BaseModel):
    device_name: str = Field(..., min_length=1, description="Имя устройства")
    text: Optional[str] = Field(None, description="Текст уведомления")
    message: Optional[str] = Field(None, description="Альтернативное поле для текста")

    @property
    def notification_text(self) -> str:
        value = (self.text or self.message or "").strip()
        if not value:
            raise ValueError("Нужно передать text или message")
        return value


app = FastAPI(title="Notify gateway")
bot = Bot(
    token=BOT_TOKEN,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML),
)
dp = Dispatcher()


@app.on_event("startup")
async def startup_event() -> None:
    asyncio.create_task(dp.start_polling(bot))


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await bot.session.close()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/notify")
@app.post("/ozpay/notify")
async def notify(request: Request) -> dict:
    body_data = {}
    try:
        if request.headers.get("content-type", "").startswith("application/json"):
            body_data = await request.json()
    except Exception:
        body_data = {}

    device_name = (
        (body_data.get("device_name") or request.query_params.get("device_name") or "").strip()
    )
    text = (
        body_data.get("text")
        or body_data.get("message")
        or request.query_params.get("text")
        or request.query_params.get("message")
        or ""
    ).strip()

    if not device_name:
        raise HTTPException(status_code=400, detail="Параметр device_name обязателен")

    if not text:
        raise HTTPException(status_code=400, detail="Нужно передать text или message")

    try:
        payload = NotifyRequest(device_name=device_name, text=text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    chat_id = DEVICE_CHAT_MAP.get(device_name)
    if chat_id is None:
        raise HTTPException(status_code=404, detail=f"Устройство '{device_name}' не найдено в карте отправки")

    try:
        message_text = payload.notification_text
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    account = get_device(device_name) or {}
    parsed = parse_message(message_text)
    formatted_text, reply_markup = format_notification_message(
        message_text,
        account_name=account.get("name"),
        balance=account.get("balance"),
    )

    await bot.send_message(
        chat_id=chat_id,
        text=f"<tg-emoji emoji-id='5877318502947229960'>💻</tg-emoji> <b>{html.escape(device_name)}</b>\n\n{formatted_text}",
        reply_markup=reply_markup,
    )

    if parsed.get("code"):
        asyncio.create_task(refresh_balance_later(device_name))

    print(f"Notification sent to device '{device_name}' (chat_id: {chat_id}): {formatted_text}")

    return {
        "status": "ok",
        "device_name": device_name,
        "chat_id": chat_id,
        "message": message_text,
        "parsed": parsed,
    }

if __name__ == "__main__":
    import uvicorn

    uvicorn_kwargs = {
        "host": "0.0.0.0",
        "port": 3000,
        "reload": False,
    }

    if SSL_CERTFILE and SSL_KEYFILE:
        uvicorn_kwargs["ssl_certfile"] = SSL_CERTFILE
        uvicorn_kwargs["ssl_keyfile"] = SSL_KEYFILE

    uvicorn.run("notify_server:app", **uvicorn_kwargs)

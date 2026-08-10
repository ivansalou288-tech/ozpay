import asyncio
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from aiogram import Bot, Dispatcher
from aiogram.enums import ParseMode
from aiogram.client.default import DefaultBotProperties

from config import BOT_TOKEN, DEVICE_CHAT_MAP, SSL_CERTFILE, SSL_KEYFILE


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

    await bot.send_message(
        chat_id=chat_id,
        text=f"<b>📱 {device_name}</b>\n\n{message_text}",
    )

    print(f"Notification sent to device '{device_name}' (chat_id: {chat_id}): {message_text}")

    return {
        "status": "ok",
        "device_name": device_name,
        "chat_id": chat_id,
        "message": message_text,
    }

if __name__ == "__main__":
    import uvicorn

    uvicorn_kwargs = {
        "host": "0.0.0.0",
        "port": 3000,
        "reload": True,
    }

    if SSL_CERTFILE and SSL_KEYFILE:
        uvicorn_kwargs["ssl_certfile"] = SSL_CERTFILE
        uvicorn_kwargs["ssl_keyfile"] = SSL_KEYFILE

    uvicorn.run("notify_server:app", **uvicorn_kwargs)

BOT_TOKEN = "8752208475:AAFbexoqOnv5-uJXjF2dw4na70eYT3gTwto"

# SSL сертификаты для HTTPS
# Если оставить пустыми, сервер будет работать по обычному HTTP.
# Пример: /etc/letsencrypt/live/your-domain/fullchain.pem
SSL_CERTFILE = "/etc/letsencrypt/live/api.ozpay.ru/cert.pem"
SSL_KEYFILE = "/etc/letsencrypt/live/api.ozpay.ru/privkey.pem"

# карта: имя устройства -> chat_id в Telegram
# например: {"redroid-1": 123456789, "alpha-device": -1001234567890}
DEVICE_CHAT_MAP = {
    "device1": -1004390313046,
    "device2": -1004390313046,
    "device3": -1004390313046,
    "device4": -1004390313046,
    "device5": -1004390313046,
    "device6": -1004390313046,
    "redroid": -1004390313046,
}

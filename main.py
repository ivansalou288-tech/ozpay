import time
import subprocess
import xml.etree.ElementTree as ET
import re
from ppadb.client import Client as AdbClient
import subprocess
from PIL import Image
import pytesseract

def connect_redroid(host="150.241.94.180", port=5555, adb_host="127.0.0.1", adb_port=5037):
    # ADB daemon usually runs locally on 127.0.0.1:5037.
    # The Redroid device itself is reached via host:port (for example 150.241.94.180:5555).
    client = AdbClient(host=adb_host, port=adb_port)

    try:
        client.remote_connect(host, port)
    except RuntimeError as exc:
        print(f"Ошибка подключения к Redroid {host}:{port}: {exc}")
        return None

    device = client.device(f"{host}:{port}")
    if device is None:
        connected = [d.serial for d in client.devices()]
        print(f"Не удалось найти устройство Redroid {host}:{port}.")
        print(f"Подключенные устройства: {connected}")
        return None

    print(f"Успешно подключено к Redroid: {host}:{port}")
    return device


device = connect_redroid()
# if device:
#     # 1. Выполнение shell-команды (проверка модели)
#     response = device.shell("getprop ro.product.model")
#     print(f"Модель устройства: {response.strip()}")

#     # # 2. Клик по координатам (X=500, Y=1000)
#     device.shell("input tap 650 100")

#     # # 3. Ввод текста
#     # device.shell("input text 'Hello_Redroid'")
#     time.sleep(4)  # Ждем немного перед скриншотом
#     # 4. Сделать скриншот экрана контейнера
#     result = device.screencap()
#     with open("redroid_screen.png", "wb") as f:
#         f.write(result)




def allScreanText():
    subprocess.run(
    ["adb", "exec-out", "screencap", "-p"],
    stdout=open("screen.png", "wb"), check=True)

    text = pytesseract.image_to_string(Image.open("screen.png"), lang="rus+eng")
    return text

def check():

    subprocess.run(
    ["adb", "exec-out", "screencap", "-p"],
    stdout=open("screen1.png", "wb"), check=True)
    text = pytesseract.image_to_string(Image.open("screen1.png"), lang="rus+eng")
    #print(text)
    text = text.replace("O", "0")
    text = text.replace("О", "0")
    text = text.replace("P", "Р")
    match = re.search(r'(\d+)\s*Р', text)
    if match:
        balance = match.group(1)
        print(f"Баланс: {balance}")


    time.sleep(2)
    device.shell("input tap 70 100")
    time.sleep(10)



    subprocess.run(
    ["adb", "exec-out", "screencap", "-p"],
    stdout=open("screen.png", "wb"), check=True)
    text1 = pytesseract.image_to_string(Image.open("screen.png"), lang="rus+eng")
    #достаем номер телефона
    phone_match = re.search(r'\+7[\d ]{9,14}\d', text1)
    phone = phone_match.group().strip() if phone_match else None
    #достаем имя
    name_match = re.search(r'^([А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+)$', text1, re.MULTILINE)
    name = name_match.group(1) if name_match else None

    print("Имя:", name)
    print("Телефон:", phone)

  
    device.shell("input tap 70 100")

check()
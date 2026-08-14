import time

from ppadb.client import Client as AdbClient

REDROID_HOST = "150.241.94.180"
REDROID_PORT = 4567
ADB_HOST = "127.0.0.1"
ADB_PORT = 5037


def connect_redroid(host: str, port: int, adb_host: str, adb_port: int):
    client = AdbClient(host=adb_host, port=adb_port)
    try:
        client.remote_connect(host, port)
    except Exception:
        pass

    device = client.device(f"{host}:{port}")
    if device is None:
        raise RuntimeError(f"Не удалось подключиться к Redroid {host}:{port}")
    return device


def tap_one_point(device, x: int, y: int):
    """Просто нажать на одну координату."""
    device.shell(f"input tap {x} {y}")
    time.sleep(0.1)


if __name__ == "__main__":
    device = connect_redroid(REDROID_HOST, REDROID_PORT, ADB_HOST, ADB_PORT)
    # x = 120
    # y = 420
    # print(f"Нажимаем в точку: ({x}, {y})")
    # tap_one_point(device, 120, 420)    # 1

    # tap_one_point(device, 600, 800)    #9

    # tap_one_point(device, 120, 800)   # 7   

    tap_one_point(device, 360, 800) #8
    time.sleep(2)

    tap_one_point(device, 360, 600) #5
    time.sleep(2)

    tap_one_point(device, 360, 420) #2
    time.sleep(2)   
    tap_one_point(device, 600, 420)     #3

    # tap_one_point(device, 600, 600) #6

    # tap_one_point(device, 120, 600) #4


    # tap_one_point(device, 360, 920) #0
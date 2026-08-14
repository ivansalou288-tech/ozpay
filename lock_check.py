import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from ppadb.client import Client as AdbClient

REDROID_HOST = "150.241.94.180"
REDROID_PORT = 4567
ADB_HOST = "127.0.0.1"
ADB_PORT = 5037
DUMP_PATH = Path("ui_dump_lock.xml")


def connect_redroid(host: str, port: int, adb_host: str, adb_port: int):
    """Подключиться к Redroid через ADB."""
    client = AdbClient(host=adb_host, port=adb_port)

    try:
        client.remote_connect(host, port)
    except Exception as exc:
        print(f"Предупреждение: remote_connect для {host}:{port} не удался: {exc}")

    device = client.device(f"{host}:{port}")
    if device is None:
        connected = [d.serial for d in client.devices()]
        raise RuntimeError(
            f"Не удалось подключиться к Redroid {host}:{port}. "
            f"Подключенные устройства: {connected}"
        )

    print(f"Подключено к Redroid: {host}:{port}")
    return device


def dump_ui_xml(device, local_path: Path = DUMP_PATH) -> Path:
    """Сделать dump UI hierarchy как локальный XML."""
    remote_path = "/sdcard/ui.xml"
    try:
        device.shell("uiautomator dump /sdcard/ui.xml")
        device.pull(remote_path, str(local_path))
    except Exception as exc:
        print(f"uiautomator dump не сработал: {exc}")
        raise

    if not local_path.exists():
        raise FileNotFoundError(f"Файл дампа не найден: {local_path}")

    return local_path


def get_dump_root(path: Path = DUMP_PATH):
    tree = ET.parse(path)
    return tree.getroot()


def parse_bounds(bounds: str):
    """Преобразовать bounds вида '[x1,y1][x2,y2]' в центр."""
    if not bounds:
        return None
    try:
        nums = re.findall(r"-?\d+", bounds)
        if len(nums) < 4:
            return None
        left, top, right, bottom = map(int, nums[:4])
    except ValueError:
        return None
    return (left + right) // 2, (top + bottom) // 2


def tap_screen_point(device, x: int, y: int):
    device.shell(f"input tap {x} {y}")


def tap_near_center(device, x: int, y: int, radius: int = 20):
    """Нажимает в центре нужной кнопки, без гонки по соседним кнопкам."""
    device.shell(f"input tap {x} {y}")
    time.sleep(0.08)


def read_dump_text(path: Path = DUMP_PATH) -> str:
    """Вернуть текст из XML-дампа UI hierarchy."""
    tree = ET.parse(path)
    root = tree.getroot()

    texts = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            value = node.attrib.get(attr)
            if value and value.strip():
                clean = " ".join(value.split())
                if len(clean) >= 1 and not clean.startswith("android."):
                    texts.append(clean)
    return "\n".join(dict.fromkeys(texts))


PIN_KEY_COORDS = {
    "1": (120, 420),
    "2": (360, 420),
    "3": (600, 420),
    "4": (120, 600),
    "5": (360, 600),
    "6": (600, 600),
    "7": (120, 800),
    "8": (360, 800),
    "9": (600, 800),
    "0": (360, 920),
}


def print_digit_coordinates():
    """Вывести все координаты цифр на экране блокировки."""
    print("=== Координаты цифр на PIN-экране ===")
    for digit in ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]:
        x, y = PIN_KEY_COORDS[digit]
        print(f"digit={digit} center=({x}, {y})")
    print("=== Конец координат ===")


def find_digit_nodes(root):
    """Найти цифровые кнопки на экране: {'1': (x, y), ...}."""
    digits = {}
    for node in root.iter():
        for attr in ("text", "content-desc", "hint"):
            value = (node.attrib.get(attr) or "").strip()
            if re.fullmatch(r"[0-9]", value):
                center = parse_bounds(node.attrib.get("bounds"))
                if center:
                    digits[value] = center
                    break
    return digits


def is_lock_screen(device) -> bool:
    """Проверяет, находится ли ЛК на экране ввода PIN-кода."""
    try:
        dump_path = dump_ui_xml(device)
        root = get_dump_root(dump_path)
        dump_text = read_dump_text(dump_path)
    except Exception:
        return False

    digits = find_digit_nodes(root)
    text_l = dump_text.lower()

    # По реальному UI экрана блокировки маркеры всегда есть: 'Выйти' и 'Не помню код—пароль'.
    if re.search(r"выйти|не помню|код[-— ]?пароль|enter pin|enter password|password", dump_text, flags=re.IGNORECASE):
        return True

    # Фоллбек: если в дампе есть явно цифровая сетка.
    if len(digits) >= 3:
        has_numeric_grid = set("0123456789") <= set(digits.keys())
        if has_numeric_grid:
            return True

    # Иногда отображается только часть всего экрана, но текстовой маркер всё равно есть.
    if "выйти" in text_l or "не помню" in text_l or "код-пароль" in text_l or "код пароль" in text_l:
        return True

    return False


def _normalize_password_digits(password: str):
    """Приводит пароль к списку цифр: '1 5 7 3' -> ['1', '5', '7', '3']"""
    if password is None:
        return []
    return re.findall(r"\d", str(password))


def enter_lock_password(device, password: str) -> bool:
    """Если экран пароля обнаружен — нажать нужные цифры в правильном порядке."""
    if not is_lock_screen(device):
        return False

    digits = _normalize_password_digits(password)
    if not digits:
        return False

    print(f"PIN order: {digits}")

    for ch in digits:
        center = PIN_KEY_COORDS.get(ch)
        if center is None:
            print(f"Нет координат для цифры: {ch!r}")
            return False

        print(f"Tap digit={ch} at center={center}")
        tap_near_center(device, *center)
        time.sleep(0.25)

    return True


def main() -> None:
    try:
        device = connect_redroid(REDROID_HOST, REDROID_PORT, ADB_HOST, ADB_PORT)
        if is_lock_screen(device):
            print("ЛК находится на экране пароля.")
            print_digit_coordinates()
            ok = enter_lock_password(device, "1537")
            if ok:
                print("Пароль 1973 успешно введён.")
            else:
                print("Не удалось ввести пароль 1973.")
        else:
            print("ЛК не на экране пароля.")
    except Exception as exc:
        print(f"Ошибка: {exc}")
        raise


if __name__ == "__main__":
    main()

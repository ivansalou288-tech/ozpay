import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from db_api import *
from ppadb.client import Client as AdbClient
import os
import datetime
from tap_one_point import tap_one_point

REDROID_HOST = "153.80.251.46"
REDROID_PORT = 4567
ADB_HOST = "127.0.0.1"
ADB_PORT = 5037
DUMP_PATH = Path("ui_dump.xml")


def log(msg: str):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def connect_redroid(device_name: str, adb_host: str = ADB_HOST, adb_port: int = ADB_PORT):
    """Подключиться к Redroid через ADB daemon."""
    client = AdbClient(host=adb_host, port=adb_port)
    host = get_ip(device_name)
    port = get_port(device_name)
    # Validate that we have an IP and port for the device; fail early with a clear message
    if host is None or port is None:
        raise RuntimeError(f"У устройства {device_name!r} не указаны IP или порт в базе: ip={host!r}, port={port!r}")
    try:
        port = int(port)
    except Exception:
        # leave as-is; remote_connect will raise a clearer error if port invalid
        pass
    # If the device is already connected to ADB, use it directly (avoids remote_connect hang)
    try:
        connected = client.devices()
        for d in connected:
            if d.serial == f"{host}:{port}":
                print(f"Подключено к уже-существующему Redroid: {host}:{port}")
                return d
    except Exception:
        # ignore errors listing devices; we'll try remote_connect below
        connected = []

    # Quick probe the remote host:port with a short socket timeout to avoid long blocking
    import socket
    try:
        with socket.create_connection((host, int(port)), timeout=3):
            pass
    except Exception as exc:
        raise RuntimeError(f"Redroid {host}:{port} недоступен (socket probe failed): {exc}")

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


def probe_adb(host: str, port: int, adb_host: str = ADB_HOST, adb_port: int = ADB_PORT):
    """Проверить, что host:port доступен через ADB. Без записи в БД."""
    import socket

    host = (host or "").strip()
    try:
        port = int(port)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Порт должен быть числом") from exc
    if not host:
        raise RuntimeError("Укажите IP")

    serial = f"{host}:{port}"
    client = AdbClient(host=adb_host, port=adb_port)

    try:
        for device in client.devices():
            if device.serial == serial:
                device.shell("echo ok")
                return True
    except Exception:
        pass

    try:
        with socket.create_connection((host, port), timeout=3):
            pass
    except Exception as exc:
        raise RuntimeError(f"Не удалось подключиться к {serial}: {exc}") from exc

    try:
        client.remote_connect(host, port)
    except Exception as exc:
        raise RuntimeError(f"ADB connect к {serial} не удался: {exc}") from exc

    device = client.device(serial)
    if device is None:
        connected = []
        try:
            connected = [item.serial for item in client.devices()]
        except Exception:
            pass
        raise RuntimeError(
            f"Не удалось подключиться к {serial}. "
            f"Подключенные устройства: {connected}"
        )

    try:
        device.shell("echo ok")
    except Exception as exc:
        raise RuntimeError(f"ADB на {serial} не отвечает: {exc}") from exc
    return True


def dump_ui_xml(device, local_path: Path = DUMP_PATH) -> Path:
    """Получить XML-дамп UI hierarchy с устройства и сохранить локально."""
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


def get_dump_text(device) -> str:
    """Одна функция: возвращает текст среды из XML-дампа UI hierarchy."""
    dump_path = dump_ui_xml(device)
    return read_dump_text(dump_path)


def read_dump_text(path: Path = DUMP_PATH) -> str:
    """Вернуть чистый текст из XML-дампа UI hierarchy."""
    tree = ET.parse(path)
    root = tree.getroot()

    texts = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            value = node.attrib.get(attr)
            if value and value.strip():
                clean = " ".join(value.split())
                if len(clean) >= 2 and not clean.startswith("android."):
                    texts.append(clean)

    return "\n".join(dict.fromkeys(texts))


def get_dump_root(path: Path = DUMP_PATH):
    """Возвращает XML root из локального дампа."""
    tree = ET.parse(path)
    return tree.getroot()


def parse_bounds(bounds: str):
    """Парсит bounds из XML вида 'left top right bottom' и возвращает центр и верхнюю середину."""
    if not bounds:
        return None
    try:
        left, top, right, bottom = map(int, re.findall(r"-?\d+", bounds))
    except ValueError:
        return None
    center = ((left + right) // 2, (top + bottom) // 2)
    top_center = ((left + right) // 2, top + max(2, (bottom - top) // 10))
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "center": center,
        "top_center": top_center,
    }


def _text_to_digit(value: str):
    """Normalize UI text like 'цифра 0', 'цифра ноль', 'digit zero' to a single digit '0'..'9'."""
    if not value:
        return None
    s = value.strip().lower()
    # Remove common prefix words like 'цифра' or 'digit'
    m = re.fullmatch(r"(?:цифра\s*|digit\s*)?(.*)", s, flags=re.IGNORECASE)
    core = m.group(1).strip() if m else s

    # English and Russian word -> digit maps
    en_words = {
        'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
        'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9'
    }
    ru_words = {
        'ноль': '0', 'один': '1', 'два': '2', 'три': '3', 'четыре': '4',
        'пять': '5', 'шесть': '6', 'семь': '7', 'восемь': '8', 'девять': '9'
    }

    # Direct digit
    if re.fullmatch(r"[0-9]", core):
        return core
    # Word forms
    if core in en_words:
        return en_words[core]
    if core in ru_words:
        return ru_words[core]
    return None


def tap_screen_point(device, *args):
    """Нажимает на координату на экране.

    Поддерживает вызовы в трёх форматах:
    - `tap_screen_point(device, x, y)`
    - `tap_screen_point(device, (x, y))` или `tap_screen_point(device, [x, y])`
    - `tap_screen_point(device, bounds_dict)` где `bounds_dict` — результат `parse_bounds()`
    """
    x = y = None
    if len(args) == 1:
        v = args[0]
        if isinstance(v, (tuple, list)) and len(v) >= 2:
            x, y = int(v[0]), int(v[1])
        elif isinstance(v, dict):
            # prefer explicit 'center' or 'top_center'
            if "center" in v and isinstance(v["center"], (tuple, list)):
                x, y = int(v["center"][0]), int(v["center"][1])
            elif "top_center" in v and isinstance(v["top_center"], (tuple, list)):
                x, y = int(v["top_center"][0]), int(v["top_center"][1])
            else:
                # As a fallback, try left/top
                if "left" in v and "top" in v:
                    x, y = int(v["left"]), int(v["top"])
    elif len(args) >= 2:
        try:
            x, y = int(args[0]), int(args[1])
        except Exception:
            x = y = None

    if x is None or y is None:
        log(f"tap_screen_point: invalid coordinates args={args}")
        return

    log(f"tap_screen_point: x={x} y={y}")
    try:
        device.shell(f"input tap {x} {y}")
    except Exception as exc:
        log(f"tap failed: {exc}")


def press_back(device):
    """Нажимает кнопку назад."""
    log("press_back: sending keyevent 4")
    try:
        device.shell("input keyevent 4")
    except Exception as exc:
        log(f"press_back failed: {exc}")


def find_ui_element_by_text(device, text_pattern: str, attrs=("text", "content-desc", "resource-id"), exact: bool = False):
    """Ищет UI-элемент по тексту/description в текущем дампе и возвращает (text, center, attr)."""
    dump_path = dump_ui_xml(device)
    log(f"find_ui_element_by_text: dump_path={dump_path}")
    root = get_dump_root(dump_path)

    dump_text = ET.tostring(root, encoding="unicode", method="xml")
    log(f"find_ui_element_by_text: dump preview:\n{dump_text[:2000]}")

    matches = []
    matches_zero = []
    candidate_texts = []

    for node in root.iter():
        for attr in attrs:
            value = node.attrib.get(attr)
            if value is None:
                continue
            text = " ".join(value.split())
            if not text or text.startswith("android."):
                continue
            candidate_texts.append(text)

            try:
                if exact:
                    ok = text.lower() == text_pattern.lower()
                else:
                    ok = re.search(text_pattern, text, flags=re.IGNORECASE) is not None
            except re.error:
                ok = text_pattern.lower() in text.lower()

            if not ok:
                continue

            bounds = parse_bounds(node.attrib.get("bounds"))
            if bounds is None:
                continue

            center = bounds["center"]
            if center[0] == 0 and center[1] == 0:
                log(f"find_ui_element_by_text: found '{text}' but center is (0,0), marking as zero-center candidate")
                matches_zero.append((text, (0, 0), attr))
                continue

            matches.append((text, bounds["top_center"], attr))

    if matches:
        text, tap_point, attr = matches[0]
        log(f"find_ui_element_by_text: pattern={text_pattern!r} -> found '{attr}'='{text}' at top_center={tap_point}")
        return text, tap_point, attr

    # If we didn't find any usable centers but have zero-center candidates, return the first
    if matches_zero:
        text, tap_point, attr = matches_zero[0]
        log(f"find_ui_element_by_text: pattern={text_pattern!r} -> found zero-center candidate '{attr}'='{text}' at top_center={tap_point}")
        return text, tap_point, attr

    if candidate_texts:
        preview = ", ".join(list(dict.fromkeys(candidate_texts))[:20])
        log(f"find_ui_element_by_text: pattern={text_pattern!r} not found. candidates={preview}")
    else:
        log(f"find_ui_element_by_text: pattern={text_pattern!r} not found. dump has no text fields")
    return None


def find_and_tap_ui_element(device, text_pattern: str, attrs=("text", "content-desc", "resource-id"), exact: bool = False):
    """Находит UI-элемент по тексту/description и нажимает в верхнюю середину элемента."""
    # Try to find the element. If its center is (0,0), perform a swipe and retry until a usable center is found.
    attempts = 0
    while True:
        result = find_ui_element_by_text(device, text_pattern, attrs=attrs, exact=exact)
        if not result:
            return False

        _, tap_point, _ = result
        # If center is (0,0) — likely off-screen or not laid out yet: swipe and retry
        if isinstance(tap_point, (tuple, list)) and len(tap_point) >= 2 and tap_point[0] == 0 and tap_point[1] == 0:
            log(f"find_and_tap_ui_element: element '{text_pattern}' center is (0,0), swiping to reveal (attempt {attempts+1})")
            try:
                device.shell(f"input swipe 700 900 700 300")
            except Exception as exc:
                log(f"find_and_tap_ui_element: swipe failed: {exc}")
            time.sleep(2.0)
            attempts += 1
            # Safety: avoid infinite loop — give up after many attempts
            if attempts > 20:
                log(f"find_and_tap_ui_element: giving up after {attempts} swipes")
                return False
            continue

        tap_screen_point(device, *tap_point)
        return True


def tap_by_text(device, text_pattern: str, attrs=("text", "content-desc", "resource-id"), exact: bool = False):
    """Совместимая обертка для старого вызова tap_by_text."""
    return find_and_tap_ui_element(device, text_pattern, attrs=attrs, exact=exact)


def _get_password_from_env_or_file() -> str:
    """Попытаться получить пароль из переменной окружения `LK_PASSWORD` или файла `password.txt`."""
    pwd = os.environ.get("LK_PASSWORD")
    if pwd:
        return pwd
    # Check current working directory first, then the script directory
    candidate_paths = [Path("password.txt"), Path(__file__).resolve().parent / "password.txt"]
    for pw_file in candidate_paths:
        if pw_file.exists():
            try:
                return pw_file.read_text(encoding="utf-8").strip()
            except Exception:
                return None
    return None


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


def is_lock_screen_text(dump_text: str, root=None) -> bool:
    """Экран блокировки, если в XML есть явные подписи цифр: 'цифра один', 'цифра 1', 'digit one', 'digit 1' и т.п."""
    text = (dump_text or "").lower()
    if not text:
        return False

    digit_labels = [
        r"\bцифра\s*(?:один|1)\b",
        r"\bцифра\s*(?:два|2)\b",
        r"\bцифра\s*(?:три|3)\b",
        r"\bцифра\s*(?:четыре|4)\b",
        r"\bцифра\s*(?:пять|5)\b",
        r"\bцифра\s*(?:шесть|6)\b",
        r"\bцифра\s*(?:семь|7)\b",
        r"\bцифра\s*(?:восемь|8)\b",
        r"\bцифра\s*(?:девять|9)\b",
        r"\bцифра\s*(?:ноль|0)\b",
        r"\bdigit\s*(?:one|1)\b",
        r"\bdigit\s*(?:two|2)\b",
        r"\bdigit\s*(?:three|3)\b",
        r"\bdigit\s*(?:four|4)\b",
        r"\bdigit\s*(?:five|5)\b",
        r"\bdigit\s*(?:six|6)\b",
        r"\bdigit\s*(?:seven|7)\b",
        r"\bdigit\s*(?:eight|8)\b",
        r"\bdigit\s*(?:nine|9)\b",
        r"\bdigit\s*(?:zero|0)\b",
    ]
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in digit_labels)


def tap_pin_digit(device, digit: str):
    """Нажимает цифру по UI-элементу, а не по статическим координатам."""
    dump_path = dump_ui_xml(device)
    root = get_dump_root(dump_path)
    target = None

    for node in root.iter():
        for attr in ("text", "content-desc", "hint"):
            value = (node.attrib.get(attr) or "").strip()
            if not value:
                continue
            mapped = _text_to_digit(value)
            if mapped is not None and mapped == str(digit):
                center = parse_bounds(node.attrib.get("bounds"))
                if center:
                    target = center
                    break
        if target:
            break

    if target is None:
        raise ValueError(f"Не найден UI-элемент для цифры {digit!r} на экране блокировки")

    print(f"Tap digit={digit} via UI element at center={target}")
    tap_screen_point(device, target)
    time.sleep(0.3)


def _normalize_password_digits(password: str):
    """Приводит пароль к списку цифр: '1 5 7 3' -> ['1', '5', '7', '3']"""
    if password is None:
        return []
    return re.findall(r"\d", str(password))


def parse_entered_pin_count(dump_text: str):
    """Возвращает (введено, всего) по строке 'Введено 1 из 4 цифр'."""
    if not dump_text:
        return 0, 0
    match = re.search(r"введено\s+(\d+)\s+из\s+(\d+)\s*цифр", dump_text, flags=re.IGNORECASE)
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2))


def tap_pin_digit_and_wait(device, digit: str, expected_count: int) -> bool:
    """Нажимает цифру, ждёт появления нужного count и возвращает True только при успешном вводе."""
    before_count, before_total = parse_entered_pin_count(get_dump_text(device))
    if before_count >= expected_count:
        return True

    tap_pin_digit(device, digit)

    # After tapping, print the current UI dump for debugging/visibility
    try:
        post_dump = get_dump_text(device)
        print("=== Дамп после нажатия ===")
        print(post_dump)
    except Exception as exc:
        print(f"Не удалось получить дамп после нажатия: {exc}")

    deadline = time.time() + 6.0
    while time.time() < deadline:
        try:
            dump_text = get_dump_text(device)
        except Exception:
            time.sleep(0.2)
            continue

        current_count, total = parse_entered_pin_count(dump_text)
        # Normal success: counter shows expected_count out of total
        if total and current_count == expected_count:
            print(f"Проверка: введено {current_count} из {total} цифр")
            return True
        # Special case: after the final digit the UI may remove the counter entirely.
        # If the counter existed before and its total equals expected_count (we just entered the last digit),
        # and now the counter is gone (total==0), consider this a success.
        if total == 0 and before_total and expected_count == before_total:
            print("Проверка: счётчик пропал после последней цифры — считаем ввод успешным")
            return True
        if current_count > expected_count:
            print(f"Слишком много цифр после нажатия {digit}: {current_count} > {expected_count}")
            return False
        time.sleep(0.2)

    print(f"После нажатия {digit} не появился ожидаемый счётчик: ожидалось {expected_count}")
    return False


def enter_lock_password(device, password: str) -> bool:
    """Если открылся экран пароля — вводит PIN по UI-элементам и ждёт подтверждения счетчика введённых цифр."""
    pwd = _normalize_password_digits(password)
    if not pwd:
        return False

    dump_text = get_dump_text(device)
    if not is_lock_screen_text(dump_text):
        return False

    print(f"PIN order: {pwd}")
    # If the UI does not show any entered-digit counter, fall back to blind entry
    before_count, before_total = parse_entered_pin_count(dump_text)
    if before_total == 0:
        print("Счётчик не обнаружен — ввод вслепую (без ожидания счётчика)")
        for index, digit in enumerate(pwd, start=1):
            try:
                tap_pin_digit(device, digit)
            except Exception as exc:
                # Fallback to static coordinates if available
                coords = PIN_KEY_COORDS.get(str(digit))
                if coords:
                    print(f"Fallback: tap coords for digit={digit} at {coords}")
                    try:
                        tap_screen_point(device, *coords)
                    except Exception as exc2:
                        print(f"Не удалось нажать координаты для {digit}: {exc2}")
                        return False
                else:
                    print(f"Ошибка: не найден UI-элемент и нет координат для цифры {digit}: {exc}")
                    return False

            # print dump after each tap for visibility
            try:
                print("=== Дамп после нажатия (вслепую) ===")
                print(get_dump_text(device))
            except Exception:
                pass

            time.sleep(0.2)

        return True

    # Normal behaviour: wait for counter after each digit
    for index, digit in enumerate(pwd, start=1):
        if not tap_pin_digit_and_wait(device, digit, expected_count=index):
            return False
        time.sleep(0.2)
    return True


def ensure_lock_screen_unlocked(device, password: str) -> bool:
    """Если приложение на экране пароля, вводит пароль и возвращает True."""
    try:
        dump_path = dump_ui_xml(device)
        root = get_dump_root(dump_path)
        dump_text = read_dump_text(dump_path)
    except Exception:
        return False

    if not is_lock_screen_text(dump_text, root=root):
        return False

    
    print("ЛК находится на экране пароля.")
    print(f"Используем пароль: {password}")

    ok = enter_lock_password(device, password)
    if ok:
        print(f"Пароль {password} успешно введён.")
        return True

    print(f"Не удалось ввести пароль {password}.")
    return False


def find_password_nodes(root):
    """Найти узлы, соответствующие полю ввода пароля/пина в дампе UI."""
    nodes = []
    for node in root.iter():
        # Явный атрибут password
        if node.attrib.get("password") == "true":
            nodes.append(node)
            continue

        cls = node.attrib.get("class", "") or ""
        resource = node.attrib.get("resource-id", "") or ""
        text = (node.attrib.get("text") or node.attrib.get("content-desc") or node.attrib.get("hint") or "")

        if "EditText" in cls or "password" in resource.lower() or re.search(r"парол|pin|код|password|pin", text, flags=re.IGNORECASE):
            nodes.append(node)
    return nodes


def find_key_nodes(root):
    """Найти кнопку-клавиши цифровой клавиатуры на экране и вернуть словарь digit->(x,y)."""
    keys = {}
    for node in root.iter():
        # проверяем текст и content-desc на одиночную цифру
        for attr in ("text", "content-desc", "hint"):
            value = node.attrib.get(attr) or ""
            digit = _text_to_digit(value)
            if digit is None:
                continue
            # убедимся, что это именно кнопка: кликабельный или имеет класс Button/ImageButton
            clickable = (node.attrib.get("clickable") or "").lower()
            cls = node.attrib.get("class") or ""
            if clickable != "true" and not re.search(r"Button|ImageButton|ImageView", cls):
                continue
            # избегаем ярлыков/подсказок, которые случайно содержат цифру, но не являются клавишей
            low = value.strip().lower()
            if re.search(r"выйти|не помню|непомню|код‑пароль|код-?пароль", low, flags=re.IGNORECASE):
                continue
            center = parse_bounds(node.attrib.get("bounds"))
            if center:
                keys[digit] = center
                break
    return keys


def _adb_escape_text(s: str) -> str:
    """Экранирует текст для `adb shell input text` (простой подход)."""
    if s is None:
        return ""
    # adb input text: space -> %s, остальные символы обычно проходят, но экранируем проценты
    return s.replace("%", "%25").replace(" ", "%s")




def find_card_nodes(root):
    """Находит карточки на текущем экране по тексту и/или цифрам карты."""
    candidates = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            value = node.attrib.get(attr)
            if not value:
                continue
            text = " ".join(value.split())
            if text.startswith("android."):
                continue
            if re.search(r"(?:Bank\s+Card|Карта|Visa|Mastercard|Мир|MIR|\d{4})", text, flags=re.IGNORECASE):
                center = parse_bounds(node.attrib.get("bounds"))
                if center:
                    candidates.append((center, text))
    filtered = []
    for center, text in candidates:
        lower = text.lower()
        if any(token in lower for token in ["показать", "добавить", "настройки", "меню", "главная", "аккаунт", "счёт", "выход", "оплатить", "перевести", "пополнить"]):
            continue
        if len(text) < 3:
            continue
        filtered.append((center, text))
    return filtered


def parse_all_cards(device, max_cards: int = 20):
    """Открывает каждую карту, нажимает Показать, парсит данные и возвращается назад."""
    results = []
    seen = set()

    for _ in range(max_cards):
        dump_path = dump_ui_xml(device)
        root = get_dump_root(dump_path)
        cards = find_card_nodes(root)

        if not cards:
            current_text = read_dump_text(dump_path)
            parsed = parse_card_data(current_text)
            if parsed["card_number"] or parsed["card_last4"] or parsed["expiry"] or parsed["cvv"]:
                results.append({"card_label": "current", **parsed})
            break

        center, label = cards[0]
        card_key = re.sub(r"\s+", " ", label).strip()
        if card_key in seen:
            break
        seen.add(card_key)

        # `center` may be a dict returned by `parse_bounds()`; pass it directly
        tap_screen_point(device, center)

        detail_path = dump_ui_xml(device)
        detail_text = read_dump_text(detail_path)
        if re.search(r"Показать|Show", detail_text, flags=re.IGNORECASE):
            if not tap_by_text(device, r"Показать|Show"):
                break
            detail_path = dump_ui_xml(device)
            detail_text = read_dump_text(detail_path)

        parsed = parse_card_data(detail_text)
        if parsed["card_number"] or parsed["card_last4"] or parsed["expiry"] or parsed["cvv"]:
            results.append({"card_label": card_key, **parsed})

        press_back(device)

        next_dump = dump_ui_xml(device)
        next_text = read_dump_text(next_dump)
        if re.search(r"Показать|Show", next_text, flags=re.IGNORECASE) and not find_card_nodes(get_dump_root(next_dump)):
            press_back(device)

    return results


def extract_account_owner_name(text: str):
    """Извлекает имя владельца аккаунта, например: 'Евгений Ляпин' или 'Евгений Л.'."""
    blocked = {
        "аккаунт",
        "основной счёт",
        "баланс",
        "оплатить",
        "пополнить",
        "перевести",
        "выйти",
        "подписка",
        "мои документы",
        "профиль",
        "картa",
        "счёт",
    }

    for line in text.splitlines():
        candidate = " ".join(line.split())
        if not candidate or len(candidate) < 3:
            continue
        lower = candidate.lower()
        if any(word in lower for word in blocked):
            continue
        if not re.search(r"[А-ЯЁа-яё]", candidate):
            continue
        if re.fullmatch(r"[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}(?:\s+[А-ЯЁ]\.)?", candidate):
            return candidate.strip()

    patterns = [
        r"(?m)^[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.$",
        r"(?m)^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.$",
        r"(?m)^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$",
        r"(?m)^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(0).strip()
    return None


def parse_balance_and_account_name(text: str):
    """Парсит баланс и имя аккаунта. Если данных нет — возвращает None."""
    account_name = extract_account_owner_name(text)
    balance = None

    balance_match = re.search(r"(?:Баланс|Остаток|Основной\s+счёт|Счёт)\s*[:\-]?\s*(\d[\d\s.,]*)\s*₽", text, flags=re.IGNORECASE)
    if balance_match:
        balance = balance_match.group(1).strip().replace(" ", "") or None

    return {"account_name": account_name, "balance": balance}


def parse_number_and_account_name(text: str):
    """Парсит номер карты и имя аккаунта. Если нет — None."""
    account_name = extract_account_owner_name(text)
    number = None

    phone_match = re.search(r"\+7\s*\(?\d{3}\)?\s*\d{3}\s*[- ]?\d{2}\s*[- ]?\d{2}", text)
    if phone_match:
        number = phone_match.group(0).replace(" ", "").replace("(", "").replace(")", "")
    else:
        number_match = re.search(r"\b(?:\d{4}\s?){4}\b", text)
        if number_match:
            number = number_match.group(0).replace(" ", "")

    return {"account_name": account_name, "number": number}


def parse_phone_number(text: str):
    """Парсит номер телефона из dump. Если телефона нет — None."""
    phone_match = re.search(r"\+7\s*\(?\d{3}\)?\s*\d{3}\s*[- ]?\d{2}\s*[- ]?\d{2}", text)
    if phone_match:
        return phone_match.group(0).replace(" ", "").replace("(", "").replace(")", "")
    return None


def parse_card_data(text: str):
    """Парсит номер карты, срок, CVV, тип и last4. Если данных нет — None."""
    data = {
        "card_number": None,
        "card_last4": None,
        "expiry": None,
        "cvv": None,
        "card_type": None,
        "card_variant": None,
    }

    phone_pattern = r"\+7\s*\(?\d{3}\)?\s*\d{3}\s*[- ]?\d{2}\s*[- ]?\d{2}"
    if re.search(phone_pattern, text):
        return data

    full_number_match = re.search(r"\b(?:\d{4}[- ]?){3}\d{4}\b", text)
    if full_number_match:
        data["card_number"] = full_number_match.group(0).replace(" ", "").replace("-", "")
        data["card_last4"] = data["card_number"][-4:]
    else:
        last4_match = re.search(r"(?:Bank\s+Card|Карта|MIR|Visa|Mastercard)[^\n\r]*(\d{4})\b", text, flags=re.IGNORECASE)
        if last4_match:
            data["card_last4"] = last4_match.group(1)

    expiry_match = re.search(r"\b(?:0[1-9]|1[0-2])/(?:\d{2}|\d{4})\b", text)
    if expiry_match:
        data["expiry"] = expiry_match.group(0)

    cvv_match = re.search(r"\b\d{3}\b", text)
    if cvv_match and data["expiry"] is not None:
        data["cvv"] = cvv_match.group(0)

    type_match = re.search(r"\bBank\s+Card\b|\bMIR\s+Pay\s+Ozon\b|\bVisa\b|\bMastercard\b", text, flags=re.IGNORECASE)
    if type_match:
        data["card_type"] = type_match.group(0).strip()

    variant_match = re.search(r"Виртуальная\s+карта|Карта\s+в\s+мобильном\s+телефоне", text, flags=re.IGNORECASE)
    if variant_match:
        data["card_variant"] = variant_match.group(0).strip()

    return data


def normalize_card_label(text: str):
    """Возвращает корректный label карты, если текст содержит ровно одну карту; иначе None."""
    text = " ".join((text or "").split()).strip()
    if not text or text.startswith("android."):
        return None
    if re.search(r"Показать|Show|Детали|Оплатить|Перевести|Пополнить|Заказать\s+карту", text, flags=re.IGNORECASE):
        return None

    card_patterns = re.findall(r"(?:Bank\s+Card\s+\d{4}|Карта\s+\d{4}|\d{4})", text, flags=re.IGNORECASE)
    if len(card_patterns) != 1:
        return None

    return text


def find_card_buttons(root):
    """Находит кнопки карт на экране списка карт."""
    buttons = []
    for node in root.iter():
        value = node.attrib.get("text") or node.attrib.get("content-desc") or ""
        if not value:
            continue
        text = " ".join(value.split())
        label = normalize_card_label(text)
        if not label:
            continue

        center = parse_bounds(node.attrib.get("bounds"))
        if center:
            # parse_bounds returns a dict with keys including 'center' and 'top_center'
            coord = center.get("center") if isinstance(center, dict) else center
            if coord:
                buttons.append({"label": label, "center": coord})
    seen = set()
    unique = []
    for item in buttons:
        key = item["label"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return sorted(unique, key=lambda item: (item["center"][1], item["center"][0]))


def find_button_by_label(root, patterns):
    """Ищет кнопку/текст по паттерну, например Показать, Show."""
    for node in root.iter():
        value = node.attrib.get("text") or node.attrib.get("content-desc") or ""
        if not value:
            continue
        text = " ".join(value.split())
        if re.search(patterns, text, flags=re.IGNORECASE):
            center = parse_bounds(node.attrib.get("bounds"))
            if center:
                coord = center.get("center") if isinstance(center, dict) else center
                if not coord:
                    continue
                if coord[0] == 0 and coord[1] == 0:
                    log(f"find_button_by_label: found '{text}' but center is (0,0), skipping")
                    continue
                return {"label": text, "center": coord}
    return None


def screen_has_card_list(device) -> bool:
    """Проверяет, что текущий экран — именно список карт, а не просто любой набор текста с цифрами."""
    try:
        dump_path = dump_ui_xml(device)
        root = get_dump_root(dump_path)
    except (ET.ParseError, FileNotFoundError):
        return False

    cards = find_card_buttons(root)
    if len(cards) < 2:
        return False

    card_count = 0
    for card in cards:
        label = card["label"]
        if re.search(r"Bank\s+Card\s+\d{4}|Карта\s+\d{4}|\b\d{4}\b", label, flags=re.IGNORECASE):
            card_count += 1

    if card_count < 2:
        return False

    joined = "\n".join(card["label"].lower() for card in cards)
    for token in [
        "оплатить",
        "пополнить",
        "перевести",
        "главный экран",
        "контакты",
        "галерея",
        "google play",
        "выход",
        "настройки",
    ]:
        if token in joined:
            return False

    return True


def count_open_cards(device) -> int:
    """Определяет количество открытых карт на текущем экране списка."""
    try:
        dump_path = dump_ui_xml(device)
        root = get_dump_root(dump_path)
    except (ET.ParseError, FileNotFoundError):
        return 0

    return len(find_card_buttons(root))


def scroll_until_requisites(device, start_y: int = 900, end_y: int = 300, steps: int = 12):
    """Физически прокручивает экран до блока реквизитов."""
    for _ in range(steps):
        device.shell(f"input swipe 350 {start_y} 350 {end_y} 500")
        time.sleep(0.8)

        try:
            text = read_dump_text(dump_ui_xml(device))
        except Exception:
            continue

        if re.search(r"Реквизиты|Показать|Show|Номер карты|CVV|Срок|Действительна до", text, flags=re.IGNORECASE):
            return True
    return False


def parse_all_cards(device, max_cards: int = 20):
    """По порядку открывает каждую карту, доходит до реквизитов, нажимает Показать и парсит данные."""
    if not screen_has_card_list(device):
        return []

    total_cards = count_open_cards(device)
    limit = min(max_cards, total_cards) if total_cards else 0
    if limit == 0:
        return []

    results = []
    seen = set()
    for index in range(limit):
        dump_path = dump_ui_xml(device)
        try:
            root = get_dump_root(dump_path)
        except ET.ParseError:
            break

        cards = find_card_buttons(root)
        if index >= len(cards):
            break

        card = cards[index]
        label = card["label"]

        tap_screen_point(device, *card["center"])
        time.sleep(1.2)

        scroll_until_requisites(device)

        detail_path = dump_ui_xml(device)
        detail_root = get_dump_root(detail_path)
        show_btn = find_button_by_label(detail_root, r"Показать|Show")
        if show_btn:
            tap_screen_point(device, *show_btn["center"])
            time.sleep(1.2)

        detail_text = read_dump_text(dump_ui_xml(device))
        parsed = parse_card_data(detail_text)

        found_last4 = re.search(r"(?:Bank\s+Card\s+|Карта\s+)?(\d{4})\b", label, flags=re.IGNORECASE)
        if found_last4:
            parsed["card_last4"] = found_last4.group(1)

        if parsed["card_number"] or parsed["card_last4"] or parsed["expiry"] or parsed["cvv"]:
            fingerprint = parsed["card_number"] or parsed["card_last4"] or parsed["expiry"] or parsed["cvv"]
            if fingerprint in seen:
                press_back(device)
                time.sleep(1.0)
                continue
            seen.add(fingerprint)
            parsed["card_label"] = label
            results.append(parsed)

        press_back(device)
        time.sleep(1.0)

    return results


def format_cards_output(cards):
    """Формирует читаемый вывод списка карт."""
    if not cards:
        return "[]"

    lines = []
    for idx, card in enumerate(cards, start=1):
        label = card.get("card_label") or f"Карта {idx}"
        number = card.get("card_number") or "None"
        last4 = card.get("card_last4") or "None"
        expiry = card.get("expiry") or "None"
        cvv = card.get("cvv") or "None"
        card_type = card.get("card_type") or "None"
        variant = card.get("card_variant") or "None"

        lines.append(f"{idx}. {label}")
        lines.append(f"   номер: {number}")
        lines.append(f"   last4: {last4}")
        lines.append(f"   срок: {expiry}")
        lines.append(f"   cvv: {cvv}")
        lines.append(f"   тип: {card_type}")
        lines.append(f"   вариант: {variant}")

    return "\n".join(lines)


def parse_turnover(text: str):
    """Парсит оборот: расходы, доходы, месяц, категория."""
    result = {
        "month": None,
        "expenses": None,
        "income": None,
        "category": None,
    }

    month_match = re.search(r"\b(?:Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь)\b", text, flags=re.IGNORECASE)
    if month_match:
        result["month"] = month_match.group(0).capitalize()

    expenses_match = re.search(r"Расходы\s*(\d[\d\s.,]*)\s*₽", text, flags=re.IGNORECASE)
    if expenses_match:
        result["expenses"] = expenses_match.group(1).strip().replace(" ", "") or None

    income_match = re.search(r"Доходы\s*(\d[\d\s.,]*)\s*₽", text, flags=re.IGNORECASE)
    if income_match:
        result["income"] = income_match.group(1).strip().replace(" ", "") or None

    category_match = re.search(r"(?:Операции|Аналитика финансов|Нет карт|Выпустить карту|Перейти к аналитике финансов)", text, flags=re.IGNORECASE)
    if category_match:
        result["category"] = category_match.group(0)

    return result



def full_check(device_name):
    """Выполнить полный чек по шагам:
    1) подключиться к устройству по имени
    2) если экран блокировки — ввести пароль
    3) определить текущий экран (главная/операции/аккаунт/основной счет)
    4) перейти на Главная (нажимая кнопку Назад при необходимости)
    5) проверить баланс и имя; нажать по имени -> перейти в Аккаунт
    6) в Аккаунт: прочитать номер и имя, затем нажать Назад
    7) найти и нажать 'Все' в разделе операций
    8) прочитать оборот
    9) Назад
    10) открыть Основной счёт и прочитать все карты
    11) Назад

    Возвращает словарь с результатами.
    """

    def detect_screen(device):
        try:
            dump = get_dump_text(device)
        except Exception:
            return "unknown", ""

        # main: contains balance or 'Главная'
        if re.search(r"\bГлавная\b|Основной\s+сч[её]т|Баланс|Остаток", dump, flags=re.IGNORECASE):
            return "главная", dump
        # operations
        if re.search(r"Доходы|Расходы|Операции|Последние операции", dump, flags=re.IGNORECASE):
            return "операции", dump
        # account: phone or account name + number
        num = parse_phone_number(dump) or parse_number_and_account_name(dump).get("number")
        if num:
            return "аккаунт", dump
        # cards list
        if screen_has_card_list(device):
            return "основной счет", dump

        return "unknown", dump

    def tap_back(device):
        # try to find a labeled back button and tap it; fallback to press_back()
        try:
            dump_path = dump_ui_xml(device)
            root = get_dump_root(dump_path)
            btn = find_button_by_label(root, r"^\s*(Назад|Back|‹|←|<)\s*$")
            if btn:
                if isinstance(btn["center"], (tuple, list)):
                    tap_screen_point(device, *btn["center"])
                else:
                    tap_screen_point(device, btn["center"])
                time.sleep(1.0)
                return True
        except Exception:
            pass
        press_back(device)
        time.sleep(1.0)
        return True

    results = {
        "balance": None,
        "account_name": None,
        "account_number": None,
        "turnover": None,
        "cards": [],
    }

    device = connect_redroid(device_name=device_name)


    # 2) unlock if needed
    try:
        dump = get_dump_text(device)
    except Exception:
        dump = ""

    if is_lock_screen_text(dump):
        log("lock screen detected — attempting unlock")
        pwd = get_password(device_name)
        if not pwd:
            pwd = _get_password_from_env_or_file()
        log(f"using password: {'***' if pwd else None}")
        ok_unlock = ensure_lock_screen_unlocked(device, pwd)
        log(f"unlock result: {ok_unlock}")
        time.sleep(5.0)


    # Parse balance and account name on main screen
    try:
        main_dump = get_dump_text(device)
    except Exception:
        main_dump = ""

    account_balance_info = parse_balance_and_account_name(main_dump)
    results["account_name"] = account_balance_info.get("account_name")
    results["balance"] = account_balance_info.get("balance")

    # Try to open account details by tapping the account name if available
    account_name = results["account_name"] or ""
    sanitized_name = account_name.replace(".", "").strip() if account_name else ""
    if sanitized_name:
        log(f"full_check: tapping account name '{sanitized_name}'")
        time.sleep(1.0)
        find_and_tap_ui_element(device, sanitized_name)

        # read account details
        try:
            acct_dump = get_dump_text(device)
        except Exception:
            acct_dump = ""
        account_number_info = parse_number_and_account_name(acct_dump)
        # update results with more precise values if found
        if account_number_info.get("account_name"):
            results["account_name"] = account_number_info.get("account_name")
        results["account_number"] = account_number_info.get("number")

        tap_back(device)
        time.sleep(1.5)

    # Open operations ('Все') and parse turnover
    if find_and_tap_ui_element(device, r"Все"):
        time.sleep(1.5)
        try:
            ops_dump = get_dump_text(device)
        except Exception:
            ops_dump = ""
        turnover_info = parse_turnover(ops_dump)
        results["turnover"] = turnover_info
        tap_back(device)
        time.sleep(1.5)

    # Open main account list and parse cards
    if find_and_tap_ui_element(device, r"Основной счёт"):
        time.sleep(1.0)
        cards = parse_all_cards(device)
        results["cards"] = cards
        tap_back(device)
    # Final reporting: print collected results
    print("=== Full check result ===")
    print(f"Account name: {results.get('account_name')}")
    print(f"Balance: {results.get('balance')}")
    print(f"Account number: {results.get('account_number')}")
    print(f"Turnover: {results.get('turnover')}")
    print("Cards:")
    print(format_cards_output(results.get('cards', [])))

    # --- Serialize cards and update database ---
    def serialize_cards(cards_list):
        """Serialize list of card dicts into the required string format.

        Each card is stored as: full_number/last4/cvv
        Multiple cards are separated by ':'
        """
        out = []
        for c in (cards_list or []):
            num = c.get("card_number") or ""
            last4 = c.get("card_last4") or (num[-4:] if num else "")
            cvv = c.get("cvv") or ""
            out.append(f"{num}/{last4}/{cvv}")
        return ":".join(out)

    try:
        cards_serialized = serialize_cards(results.get("cards", []))
        # update main fields and cards in the DB
        update_device(device_name, {
            "name": results.get("account_name"),
            "balance": results.get("balance"),
            "number": results.get("account_number"),
            "income": results.get("turnover")['income'],
            "outcome": results.get("turnover")['expenses'],
            "cards": cards_serialized,
        })
        log(f"Database updated for {device_name}: cards={cards_serialized}")
    except Exception as exc:
        log(f"Failed updating DB for {device_name}: {exc}")

    return results
    
def check_balance(device_name):
    device = connect_redroid(device_name=device_name)

    try:
        dump = get_dump_text(device)
    except Exception:
        dump = ""

    if is_lock_screen_text(dump):
        log("lock screen detected — attempting unlock")
        pwd = get_password(device_name)
        if not pwd:
            pwd = _get_password_from_env_or_file()
        log(f"using password: {'***' if pwd else None}")
        ok_unlock = ensure_lock_screen_unlocked(device, pwd)
        log(f"unlock result: {ok_unlock}")
        time.sleep(5.0)


    # Parse balance and account name on main screen
    try:
        main_dump = get_dump_text(device)
    except Exception:
        main_dump = ""

    account_balance_info = parse_balance_and_account_name(main_dump)
    update_balance(device_name, account_balance_info.get('balance'))



def check_turnover(device_name):
    device = connect_redroid(device_name=device_name)

    try:
        dump = get_dump_text(device)
    except Exception:
        dump = ""

    if is_lock_screen_text(dump):
        log("lock screen detected — attempting unlock")
        pwd = get_password(device_name)
        if not pwd:
            pwd = _get_password_from_env_or_file()
        log(f"using password: {'***' if pwd else None}")
        ok_unlock = ensure_lock_screen_unlocked(device, pwd)
        log(f"unlock result: {ok_unlock}")
        time.sleep(5.0)
    
    def tap_back(device):
        # try to find a labeled back button and tap it; fallback to press_back()
        try:
            dump_path = dump_ui_xml(device)
            root = get_dump_root(dump_path)
            btn = find_button_by_label(root, r"^\s*(Назад|Back|‹|←|<)\s*$")
            if btn:
                if isinstance(btn["center"], (tuple, list)):
                    tap_screen_point(device, *btn["center"])
                else:
                    tap_screen_point(device, btn["center"])
                time.sleep(1.0)
                return True
        except Exception:
            pass
        press_back(device)
        time.sleep(1.0)
        return True




    if find_and_tap_ui_element(device, r"Все"):
        time.sleep(1.5)
        try:
            ops_dump = get_dump_text(device)
        except Exception:
            ops_dump = ""
        turnover_info = parse_turnover(ops_dump)
        update_income(device_name, turnover_info.get('income'))
        update_outcome(device_name, turnover_info.get('expenses'))
        tap_back(device)
        time.sleep(1.5)

    
    
    
def check_cards(device_name):
    device = connect_redroid(device_name=device_name)

    try:
        dump = get_dump_text(device)
    except Exception:
        dump = ""

    if is_lock_screen_text(dump):
        log("lock screen detected — attempting unlock")
        pwd = get_password(device_name)
        if not pwd:
            pwd = _get_password_from_env_or_file()
        log(f"using password: {'***' if pwd else None}")
        ok_unlock = ensure_lock_screen_unlocked(device, pwd)
        log(f"unlock result: {ok_unlock}")
        time.sleep(5.0)
    
    def tap_back(device):
            # try to find a labeled back button and tap it; fallback to press_back()
            try:
                dump_path = dump_ui_xml(device)
                root = get_dump_root(dump_path)
                btn = find_button_by_label(root, r"^\s*(Назад|Back|‹|←|<)\s*$")
                if btn:
                    if isinstance(btn["center"], (tuple, list)):
                        tap_screen_point(device, *btn["center"])
                    else:
                        tap_screen_point(device, btn["center"])
                    time.sleep(1.0)
                    return True
            except Exception:
                pass
            press_back(device)
            time.sleep(1.0)
            return True
    
    def serialize_cards(cards_list):
        """Serialize list of card dicts into the required string format.

        Each card is stored as: full_number/expiry(without "/")/cvv
        Multiple cards are separated by ':'
        """
        out = []
        for c in (cards_list or []):
            num = c.get("card_number") or ""
            expiry = (c.get("expiry") or "").replace("/", "")
            cvv = c.get("cvv") or ""
            out.append(f"{num}/{expiry}/{cvv}")
        return ":".join(out)




    if find_and_tap_ui_element(device, r"Основной счёт"):
        time.sleep(1.0)
        cards = parse_all_cards(device)
        print(cards)
        cards_serialized = serialize_cards(cards)
        tap_back(device)
        update_cards(device_name, cards_serialized)


        




if __name__ == "__main__":
    # device=connect_redroid(device_name='device1')
    # try:
    #     ops_dump = get_dump_text(device)
    # except Exception:
    #     ops_dump = ""
    # turnover_info = parse_turnover(ops_dump)
    # print(turnover_info)

    # full_check('device1')
    # check_balance('device1')
    # check_turnover('device1')
    check_cards('device1')
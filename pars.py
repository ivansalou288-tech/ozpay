import re


def parse_message(message: str):
    text = " ".join((message or "").split())
    if not text:
        return {"code": None, "amount": None, "service": None}

    result = {"code": None, "amount": None, "service": None}

    code_candidates = []
    for match in re.finditer(r"\d{4,8}", text):
        start = max(0, match.start() - 50)
        end = min(len(text), match.end() + 50)
        context = text[start:end].lower()
        if "код" in context or "кода" in context or "кодом" in context:
            code_candidates.append(match.group())

    if code_candidates:
        result["code"] = code_candidates[0]

    amount_match = re.search(
        r"(?i)(?:на|для\s+перевода)\s*(\d+(?:[.,]\d+)?)\s*(?:₽|руб(?:лей)?|rub)?",
        text,
    )
    if amount_match is None:
        amount_match = re.search(
            r"(?i)(\d+(?:[.,]\d+)?)\s*(?:₽|руб(?:лей)?|rub)",
            text,
        )
    if amount_match:
        result["amount"] = amount_match.group(1).replace(",", ".")

    service_aliases = [
        ("Yandex Bank", ["yandex bank", "яндекс банк"]),
        ("Ozon Банк", ["ozon банк", "ozon bank"]),
        ("Ozon", ["ozon"]),
        ("FUNPAY", ["funpay"]),
    ]

    service_candidates = []
    lower_text = text.lower()
    for service_name, aliases in service_aliases:
        for alias in aliases:
            index = lower_text.find(alias)
            if index != -1:
                service_candidates.append((index, service_name))

    if service_candidates:
        result["service"] = min(service_candidates, key=lambda item: item[0])[1]

    return result


text = "Никому его не сообщайте. Используйте только для входа в аккаунт Ozon/Код для входа 461947"
text1 = "16550 – код оплаты в FUNPAY на 45.92 ₽. Ozon Банк/Ozon Банк"
text2 = "Никому не сообщайте код 54135 для перевода 20 ₽ в Yandex Bank Ozon Банк"

if __name__ == "__main__":
    for label, value in [("text", text), ("text1", text1), ("text2", text2)]:
        print(label, "->", parse_message(value))
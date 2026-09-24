def parse_qty(text):
    """'12' -> 12, '1 000' -> 1000, '' -> 0."""
    text = text.strip()
    if not text:
        return 0
    return int(text)


def parse_price(text):
    """'12,50 zł' -> 1250 (grosze)."""
    text = text.lower().replace("zł", "").strip().replace(",", ".")
    zl, _, gr = text.partition(".")
    return int(zl) * 100 + int((gr + "00")[:2])

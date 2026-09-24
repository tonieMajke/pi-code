def line_total(price, qty, discount_pct=0):
    """Cena w groszach * ilość, minus rabat procentowy (zaokrąglenie w dół do grosza)."""
    gross = price * qty
    return gross - gross * discount_pct // 100


def cart_total(lines, discount_pct=0):
    """lines: [(price, qty)] — rabat liczony raz, od całego koszyka."""
    total = 0
    for price, qty in lines:
        total += line_total(price, qty, discount_pct)
    return total - total * discount_pct // 100

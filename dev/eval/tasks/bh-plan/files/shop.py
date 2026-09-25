"""Koszyk sklepu."""


def total(items, vat=0.23):
    """Suma brutto: items to lista (cena_netto, ilość)."""
    net = sum(price * qty for price, qty in items)
    return round(net * (1 + vat), 2)

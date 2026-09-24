def calc_total(items, discount=0.0):
    subtotal = sum(price * qty for price, qty in items)
    return round(subtotal * (1 - discount), 2)

from shop import cart


def daily_report(orders):
    return sum(cart.calc_total(o) for o in orders)

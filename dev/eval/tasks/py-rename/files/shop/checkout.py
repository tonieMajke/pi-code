from shop.cart import calc_total


def checkout(items, coupon=None):
    discount = 0.1 if coupon == "TEN" else 0.0
    total = calc_total(items, discount)
    return {"total": total, "coupon": coupon}

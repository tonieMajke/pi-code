from shop.cart import compute_total
from shop.checkout import checkout
from report import daily_report
assert compute_total([(10.0, 2), (5.0, 1)]) == 25.0
assert checkout([(100.0, 1)], "TEN")["total"] == 90.0
assert daily_report([[(1.0, 1)], [(2.0, 2)]]) == 5.0
print("OK")

import unittest

from shop.listing import page, pages_count, sort_products
from shop.parse import parse_price, parse_qty
from shop.pricing import cart_total, line_total


class Hidden(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_qty(" 2 500 "), 2500)
        self.assertEqual(parse_price("0,05 zł"), 5)
        self.assertEqual(parse_price("1 200,00 zł"), 120000)

    def test_pricing(self):
        self.assertEqual(line_total(999, 1, 50), 500)
        self.assertEqual(cart_total([(999, 1)], 0), 999)
        self.assertEqual(cart_total([(1000, 1), (1000, 1)], 25), 1500)

    def test_listing(self):
        ps = [{"name": "Źródło", "price": 1}, {"name": "cebula", "price": 2}, {"name": "Cebula", "price": 1}]
        self.assertEqual([p["price"] for p in sort_products(ps)][:2], [1, 2])
        self.assertEqual(page(list(range(5)), 1, 2), [0, 1])
        self.assertEqual(pages_count(0), 0)
        self.assertEqual(pages_count(1), 1)


if __name__ == "__main__":
    unittest.main()

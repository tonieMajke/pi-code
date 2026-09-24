import unittest

from shop.listing import page, pages_count, sort_products
from shop.parse import parse_price, parse_qty
from shop.pricing import cart_total, line_total


class Parse(unittest.TestCase):
    def test_qty(self):
        self.assertEqual(parse_qty("12"), 12)
        self.assertEqual(parse_qty("1 000"), 1000)
        self.assertEqual(parse_qty(""), 0)

    def test_price(self):
        self.assertEqual(parse_price("12,50 zł"), 1250)
        self.assertEqual(parse_price("3 zł"), 300)


class Pricing(unittest.TestCase):
    def test_line(self):
        self.assertEqual(line_total(1000, 3), 3000)

    def test_cart_discount_once(self):
        self.assertEqual(cart_total([(1000, 1), (500, 2)], 10), 1800)


class Listing(unittest.TestCase):
    def test_sort(self):
        ps = [{"name": "banan", "price": 5}, {"name": "Arbuz", "price": 9}, {"name": "arbuz", "price": 3}]
        self.assertEqual([p["price"] for p in sort_products(ps)], [3, 9, 5])

    def test_pages(self):
        items = list(range(25))
        self.assertEqual(page(items, 1), list(range(10)))
        self.assertEqual(page(items, 3), [20, 21, 22, 23, 24])
        self.assertEqual(pages_count(25), 3)
        self.assertEqual(pages_count(20), 2)


if __name__ == "__main__":
    unittest.main()

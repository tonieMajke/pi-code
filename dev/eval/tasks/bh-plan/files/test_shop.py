import unittest

from shop import total


class TotalTest(unittest.TestCase):
    def test_total(self):
        self.assertEqual(total([(10, 2), (5, 1)]), 30.75)


if __name__ == "__main__":
    unittest.main()

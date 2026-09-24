import unittest

from ledger.money import fmt, to_cents
from ledger.parse import parse_line
from ledger.report import render, total


class T(unittest.TestCase):
	def test_cents_exact(self):
		for s, c in [("0.29", 29), ("1,15", 115), ("4.60", 460), ("35.25", 3525), ("0.57", 57), ("-2.30", -230), ("", 0)]:
			self.assertEqual(to_cents(s), c, s)
		self.assertEqual(to_cents(0.29), 29)
		self.assertEqual(to_cents(19.99), 1999)

	def test_total(self):
		rows = [parse_line(l) for l in ["a;x;0,29;j", "a;y;1,15;j", "a;z;4,60;t", "a;w;35,25;"]]
		self.assertEqual(total(rows), 4129)
		self.assertRegex(render(rows), r"RAZEM\s+41\.29")
		self.assertRegex(render(rows), r"inne\s+35\.25")

	def test_fmt_unchanged(self):
		self.assertEqual(fmt(5), "0.05")
		self.assertEqual(fmt(-230), "-2.30")


if __name__ == "__main__":
	unittest.main()

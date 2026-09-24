"""Kwoty trzymamy w groszach (int), żeby uniknąć błędów zaokrągleń."""


def to_cents(amount):
	"""'12.34' albo 12.34 -> 1234."""
	if isinstance(amount, str):
		amount = amount.strip().replace(",", ".")
		if not amount:
			return 0
		amount = float(amount)
	return int(amount * 100)


def fmt(cents):
	sign = "-" if cents < 0 else ""
	cents = abs(cents)
	return f"{sign}{cents // 100}.{cents % 100:02d}"

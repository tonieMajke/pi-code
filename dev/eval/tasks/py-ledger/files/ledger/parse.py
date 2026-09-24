from .money import to_cents


def parse_line(line):
	"""'2026-01-05;Kawa;12,50;jedzenie' -> dict."""
	parts = [p.strip() for p in line.split(";")]
	if len(parts) != 4:
		raise ValueError(f"zła linia: {line!r}")
	date, title, amount, category = parts
	return {"date": date, "title": title, "cents": to_cents(amount), "category": category or "inne"}


def parse_file(path):
	rows = []
	with open(path, encoding="utf-8") as f:
		for line in f:
			line = line.strip()
			if not line or line.startswith("#"):
				continue
			rows.append(parse_line(line))
	return rows

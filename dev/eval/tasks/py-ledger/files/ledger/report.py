from .money import fmt


def by_category(rows):
	out = {}
	for r in rows:
		out[r["category"]] = out.get(r["category"], 0) + r["cents"]
	return out


def total(rows):
	s = 0
	for r in rows:
		s += r["cents"]
	return s


def render(rows):
	lines = []
	cats = by_category(rows)
	for name in sorted(cats):
		lines.append(f"{name:<12}{fmt(cats[name]):>10}")
	lines.append("-" * 22)
	lines.append(f"{'RAZEM':<12}{fmt(total(rows)):>10}")
	return "\n".join(lines)

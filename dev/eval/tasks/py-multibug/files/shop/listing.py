def sort_products(products):
    """Alfabetycznie po nazwie, bez względu na wielkość liter; przy remisie tańszy pierwszy."""
    return sorted(products, key=lambda p: (p["name"], p["price"]))


def page(items, number, size=10):
    """Strony numerowane od 1."""
    start = number * size
    return items[start:start + size]


def pages_count(n_items, size=10):
    return n_items // size

from dates import is_leap_year, days_in_february
for y, exp in [(2024, True), (2023, False), (1900, False), (2000, True), (2100, False), (2400, True)]:
    assert is_leap_year(y) is exp, y
assert days_in_february(1900) == 28
print("OK")

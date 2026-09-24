from stats import median, mean
assert median([3, 1, 2]) == 2
assert median([4, 1, 3, 2]) == 2.5
assert median([5]) == 5
assert median([1.0, 9.0]) == 5.0
data = [9, 8, 7]
median(data)
assert data == [9, 8, 7], "median must not mutate its input"
assert mean([1, 2, 3]) == 2
print("OK")

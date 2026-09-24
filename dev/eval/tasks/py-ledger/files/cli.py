import sys

from ledger.parse import parse_file
from ledger.report import render


def main(argv):
	if len(argv) != 2:
		print("użycie: python3 cli.py plik.csv")
		return 2
	print(render(parse_file(argv[1])))
	return 0


if __name__ == "__main__":
	sys.exit(main(sys.argv))

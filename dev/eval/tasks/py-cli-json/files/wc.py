import argparse


def count(text):
    return {"lines": text.count("\n"), "words": len(text.split()), "chars": len(text)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Count lines, words and chars")
    parser.add_argument("path")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as f:
        c = count(f.read())
    print(f"{c['lines']} {c['words']} {c['chars']} {args.path}")


if __name__ == "__main__":
    main()

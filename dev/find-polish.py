# Lists lines with Polish UI text outside t()/plural() — guide for the i18n pass (has false positives).
# Usage: python3 dev/find-polish.py src/components/*.tsx
import re, sys
PL = re.compile(r"[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(nie|jest|się|dla|lub|oraz|brak|sesj\w*|plik\w*|model\w*|zmian\w*|narzędzi\w*|nowa|nowy|teraz|pytaj|wszystk\w*|kopiuj|zamknij|otwórz|przerwij|szukaj|dodaj|usuń|wyślij|komend\w*|projekt\w*|czat\w*|grup\w*|ustawieni\w*|wiadomo\w*|pracuj\w*|gotowe|odrzuć|pozwól|zawsze|anuluj)\b", re.I)
for path in sys.argv[1:]:
    for i, line in enumerate(open(path), 1):
        s = line.strip()
        if s.startswith("//") or s.startswith("*") or s.startswith("/*") or s.startswith("import "):
            continue
        # drop comments at end of line
        code = re.sub(r"\s//\s.*$", "", line)
        # remove t("...") / plural(...) contents
        code2 = re.sub(r'\bt\(\s*"(?:[^"\\]|\\.)*"', 't(""', code)
        code2 = re.sub(r'\bplural\([^)]*\)', 'plural()', code2)
        # candidate strings: quoted, template, or JSX text
        cands = re.findall(r'"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}]+)<', code2)
        hits = [next(x for x in c if x) for c in cands if any(c)]
        hits = [h for h in hits if PL.search(h) and not re.fullmatch(r"[\w\-./:@ ]*", h) or (h and re.search(r"[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]", h))]
        # also JSX text spanning a whole line (no tags)
        if not hits and not re.search(r"[=;(){}<>]", s) and PL.search(s) and not s.startswith(("case ", "return")):
            hits = [s]
        if hits:
            print(f"{path}:{i}: {s[:160]}")

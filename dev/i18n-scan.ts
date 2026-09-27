/**
 * Finds UI copy that never reaches t() / plural(). Source strings are Polish and double as keys
 * (shared/i18n.ts), so Polish text outside those calls stays Polish in the English interface.
 *
 * No parser is available here (typescript 7 ships only `version`), so this is a small lexer:
 * it walks the whole file — comments, string and template literals, regex literals, JSX tags,
 * attributes and text, nested `{…}` at any depth — and yields every literal with a flag saying
 * whether it sits inside the arguments of t() / plural(). The rules then look only at literals,
 * never at comments or identifiers:
 *
 *  1. Polish letters in any literal not inside t() / plural().
 *  2. A Polish word with no diacritics ("Nowa grupa", "Szukaj sesji") in copy-like literals: JSX
 *     text, user-facing JSX attributes, and code strings that look like a phrase (have a space,
 *     are not a class list or a path).
 *
 *  3. A word the dictionary knows as Polish (polishVocabulary) in any user-facing literal.
 *
 * Rule 2 is a fixed word list and misses what it does not know; rule 3 learns from the
 * dictionary. Rule 1 catches most copy anyway: Polish rarely goes a sentence without a diacritic.
 */

export type LiteralKind = "string" | "template" | "jsx-text" | "jsx-attr";

export interface Literal {
  from: number;
  text: string;
  kind: LiteralKind;
  /** Inside the arguments of t() / plural(): a key, not missing copy. */
  translated: boolean;
  /** JSX attribute name, or the object key a code string is the value of (`label: "…"`). */
  name?: string;
}

const IDENT = /[A-Za-z0-9_$]/;
/** After these (or at the start), `/` begins a regex and `<` may begin JSX. */
const EXPR_START = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>", ""]);
const EXPR_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "yield", "await"]);
const TRANSLATORS = new Set(["t", "plural"]);

export function literals(src: string, jsx: boolean): Literal[] {
  const out: Literal[] = [];
  const n = src.length;
  /** Last significant token: an identifier/keyword, or a punctuation char ("" at the start). */
  let prev = "";

  const isExprStart = () => EXPR_START.has(prev) || EXPR_KEYWORDS.has(prev);

  const skipSpace = (i: number): number => {
    while (i < n && /\s/.test(src[i])) i++;
    return i;
  };

  const stringEnd = (i: number): number => {
    const q = src[i];
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") {
      if (src[j] === "\\") j++;
      j++;
    }
    return Math.min(j + 1, n);
  };

  const regexEnd = (i: number): number => {
    let j = i + 1;
    let inClass = false;
    while (j < n && src[j] !== "\n") {
      const c = src[j];
      if (c === "\\") j++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        return j;
      }
      j++;
    }
    return j;
  };

  /** The object key right before `: "…"`, if any (`label: "Nowa sesja"` → "label"). */
  const keyBefore = (i: number): string | undefined => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] !== ":") return undefined;
    j--;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const end = j + 1;
    while (j >= 0 && IDENT.test(src[j])) j--;
    return end > j + 1 ? src.slice(j + 1, end) : undefined;
  };

  /** Code until the unmatched `close` (or the end). Returns the index after it. */
  function code(i: number, close: string, translated: boolean): number {
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        const j = src.indexOf("\n", i);
        i = j < 0 ? n : j;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const j = src.indexOf("*/", i + 2);
        i = j < 0 ? n : j + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const end = stringEnd(i);
        out.push({ from: i, text: src.slice(i + 1, end - 1), kind: "string", translated, name: keyBefore(i) });
        prev = "str";
        i = end;
        continue;
      }
      if (c === "`") {
        i = template(i, translated);
        prev = "str";
        continue;
      }
      if (c === "/" && isExprStart()) {
        i = regexEnd(i);
        prev = "regex";
        continue;
      }
      if (c === "<" && jsx && isExprStart() && /[A-Za-z>]/.test(src[i + 1] ?? "")) {
        const end = element(i, translated);
        if (end !== null) {
          i = end;
          prev = "jsx";
          continue;
        }
      }
      if (IDENT.test(c)) {
        let j = i;
        while (j < n && IDENT.test(src[j])) j++;
        const word = src.slice(i, j);
        const after = skipSpace(j);
        if (TRANSLATORS.has(word) && src[after] === "(" && src[i - 1] !== ".") {
          prev = ")";
          i = code(after + 1, ")", true);
          continue;
        }
        prev = word;
        i = j;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        prev = c;
        i = code(i + 1, c === "(" ? ")" : c === "[" ? "]" : "}", translated);
        prev = c === "(" ? ")" : c === "[" ? "]" : "}";
        continue;
      }
      if (c === close) return i + 1;
      if (c === ")" || c === "]" || c === "}") {
        // Unbalanced closer (a scanner slip or broken source): step over it rather than unwind.
        prev = c;
        i++;
        continue;
      }
      if (c === "=" && src[i + 1] === ">") {
        prev = "=>";
        i += 2;
        continue;
      }
      prev = c;
      i++;
    }
    return n;
  }

  /** Template literal at i: its text chunks are literals, `${…}` is code. */
  function template(i: number, translated: boolean): number {
    let j = i + 1;
    let chunk = j;
    const flush = (to: number) => {
      if (to > chunk) out.push({ from: chunk, text: src.slice(chunk, to), kind: "template", translated, name: keyBefore(i) });
    };
    while (j < n) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "`") {
        flush(j);
        return j + 1;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        flush(j);
        prev = "{";
        j = code(j + 2, "}", translated);
        chunk = j;
        continue;
      }
      j++;
    }
    flush(n);
    return n;
  }

  /** JSX element at i (`<Tag …>…</Tag>`, `<Tag />`, `<>…</>`); null when it is not one (a generic). */
  function element(i: number, translated: boolean): number | null {
    let j = i + 1;
    while (j < n && /[A-Za-z0-9_$.:-]/.test(src[j])) j++;
    const tagEnd = skipSpace(j);
    if (src[tagEnd] === "," || src.startsWith("extends", tagEnd)) return null; // <T,>(…) / <T extends …>
    j = tagEnd;
    // Attributes.
    while (j < n) {
      j = skipSpace(j);
      const c = src[j];
      if (c === "/" && src[j + 1] === ">") return j + 2;
      if (c === ">") {
        j++;
        break;
      }
      if (c === "{") {
        prev = "{";
        j = code(j + 1, "}", translated);
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        const e = src.indexOf("\n", j);
        j = e < 0 ? n : e;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        const e = src.indexOf("*/", j + 2);
        j = e < 0 ? n : e + 2;
        continue;
      }
      let k = j;
      while (k < n && /[A-Za-z0-9_$:-]/.test(src[k])) k++;
      if (k === j) return null; // not an attribute: this was no JSX after all
      const name = src.slice(j, k);
      k = skipSpace(k);
      if (src[k] !== "=") {
        j = k;
        continue;
      }
      k = skipSpace(k + 1);
      if (src[k] === '"' || src[k] === "'") {
        const end = stringEnd(k);
        out.push({ from: k, text: src.slice(k + 1, end - 1), kind: "jsx-attr", translated, name });
        j = end;
      } else if (src[k] === "{") {
        prev = "{";
        j = code(k + 1, "}", translated);
      } else j = k;
    }
    // Children.
    let text = j;
    const flush = (to: number) => {
      if (src.slice(text, to).trim()) out.push({ from: text, text: src.slice(text, to), kind: "jsx-text", translated });
    };
    while (j < n) {
      const c = src[j];
      if (c === "<" && src[j + 1] === "/") {
        flush(j);
        const e = src.indexOf(">", j);
        return e < 0 ? n : e + 1;
      }
      if (c === "<") {
        flush(j);
        const end = element(j, translated);
        j = end ?? j + 1;
        text = j;
        continue;
      }
      if (c === "{") {
        flush(j);
        prev = "{";
        j = code(j + 1, "}", translated);
        text = j;
        continue;
      }
      j++;
    }
    flush(n);
    return n;
  }

  code(0, "", false);
  return out;
}

export const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
/** Polish words that are commonly written with no diacritic at all. `\b` is ASCII-only in JS. */
export const WORDS =
  /(?<![\p{L}\d_])(wczytywanie|wczytaj|brak\w*|nic|pasuje|pasujących|komend\w*|projek\w*|sesj\w*|czat\w*|grup\w*|modele|modelu|modelem|modeli|ustawieni\w*|dodaj|wybierz|zapisz|zamknij|szukaj|tryb\w*|wszystk\w*|gotowe|nowa|nowy|nowe|nazwa|nazw\w*|katalog\w*|plik\w*|pracuj\w*|anuluj|zawsze|pytaj|edytuj|sekcja|przewi\w*|kliknij|odrzu\w*|jest|nie|tak|albo|oraz|tylko|teraz|potem|przez|dla|tej|tego|jako|jeszcze|cofnij|pokaz|ukryj|kopia|zmiany|przerwij|sprawdz\w*|zapisano|zaladuj|wiadomo\w*|odswiez|ponownie|chce|chcesz)(?![\p{L}\d_])/iu;

/** Attributes that are never shown to the user. */
const TECH_ATTRS = /^(className|key|id|type|name|href|src|role|rel|target|htmlFor|lang|autoComplete|inputMode|method|action|value|defaultValue|mode|kind|variant|size|align|side|data-[\w-]+|aria-(?!label|description|placeholder)[\w-]+|viewBox|d|fill|stroke\w*|xmlns|tabIndex|dir|accept)$/;
/** Code strings under these keys are identifiers or search terms, not copy. */
const TECH_KEYS = /^(id|cmd|kind|type|key|cls|className|icon|keywords|value|name|mode|group_id|provider|tool|role|level|event)$/;

/** A string that reads like a phrase: has a space and is not a class list, a path or a key. */
function phraseLike(text: string): boolean {
  const s = text.trim();
  if (!s.includes(" ")) return false;
  if (/^[a-z0-9]+(-[a-z0-9]+)*( [a-z0-9]+(-[a-z0-9]+)*)*$/.test(s) && /-/.test(s)) return false; // "btn small-x"
  if (/^[\w.\-/@:~]+$/.test(s)) return false;
  return true;
}

export interface Hit {
  line: number;
  rule: "polish" | "word" | "vocab";
  text: string;
}

const vocabWords = (s: string) => s.toLowerCase().match(/\p{L}{4,}/gu) ?? [];

/**
 * Rule 3's word list: words of the Polish keys in shared/i18n-en.ts that no English value uses.
 * It grows with the dictionary, so a word the UI already translates somewhere ("Kopiuj",
 * "pewno") is caught when it turns up untranslated anywhere else.
 */
export function polishVocabulary(en: Record<string, string>): Set<string> {
  const english = new Set(Object.values(en).flatMap(vocabWords));
  return new Set(Object.keys(en).flatMap(vocabWords).filter((w) => !english.has(w)));
}

/**
 * Hits for one source file. `jsx` = the file may contain JSX (.tsx). `vocab` enables rule 3:
 * any user-facing literal holding one of these words, even a single word with no diacritics.
 */
export function scanSource(src: string, jsx: boolean, vocab?: Set<string>): Hit[] {
  const hits: Hit[] = [];
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  for (const lit of literals(src, jsx)) {
    if (lit.translated) continue;
    const text = lit.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (lit.kind === "jsx-attr" && lit.name && TECH_ATTRS.test(lit.name)) continue;
    if ((lit.kind === "string" || lit.kind === "template") && lit.name && TECH_KEYS.test(lit.name)) continue;
    if (POLISH.test(text)) {
      hits.push({ line: lineOf(lit.from), rule: "polish", text });
      continue;
    }
    const copyLike = lit.kind === "jsx-text" || lit.kind === "jsx-attr" || phraseLike(text);
    if (copyLike && WORDS.test(text)) hits.push({ line: lineOf(lit.from), rule: "word", text });
    else if (vocab && vocabWords(text).some((w) => vocab.has(w))) hits.push({ line: lineOf(lit.from), rule: "vocab", text });
  }
  return hits;
}

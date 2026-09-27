import { useEffect, useState, type ComponentProps } from "react";
import { Check, Copy } from "lucide-react";
import type { Highlighter } from "shiki";
import { isExternalUrl, openExternal } from "./open-url";
import { t } from "../../shared/i18n";

const THEME = "github-dark";
const LANGS = ["typescript", "tsx", "javascript", "jsx", "bash", "python", "rust", "json", "css", "html"];

/** Lazily created shiki highlighter (grammar loading is the slow part). */
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki")
      .then(({ createHighlighter }) => createHighlighter({ themes: [THEME], langs: LANGS }))
      .catch((err) => {
        highlighterPromise = null; // allow retry after a load failure
        throw err;
      });
  }
  return highlighterPromise;
}

/**
 * Syntax-highlighted code block. Shows plain text until the highlighter
 * (and its grammars) are ready; re-highlights are debounced so token
 * streaming doesn't hammer shiki.
 */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    const t = setTimeout(() => {
      void getHighlighter()
        .then((hl) => {
          if (!on) return;
          const l = (hl.getLoadedLanguages() as readonly string[]).includes(lang) ? lang : "text";
          setHtml(hl.codeToHtml(code, { lang: l, theme: THEME })); // shiki output, trusted
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [code, lang]);

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang === "text" ? "" : lang}</span>
        <CopyButton text={code} />
      </div>
      {html ? (
        <div className="codeblock-code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WebKitGTK outside a secure context: fall back to the legacy path.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function CopyButton({ text, label = t("Kopiuj") }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={() => {
        void copyText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      title={label}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      <span>{done ? t("Skopiowano") : label}</span>
    </button>
  );
}

const codeProps = (props: ComponentProps<"code">) => {
  const { className, children } = props;
  const match = /language-(\w+)/.exec(className ?? "");
  const text = String(children ?? "").replace(/\n$/, "");
  const isBlock = Boolean(match) || text.includes("\n");
  if (!isBlock) return <code className={className}>{children}</code>;
  return <CodeBlock code={text} lang={match?.[1] ?? "text"} />;
};

const preProps = (props: ComponentProps<"pre">) => <>{props.children}</>;

/**
 * Links in a reply open in the user's browser (target=_blank does nothing in the Tauri webview on
 * Linux). Anything but http(s)/mailto stays inert: a click must not navigate the app itself.
 */
const linkProps = ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
  <a
    {...props}
    target="_blank"
    rel="noreferrer"
    title={props.title ?? props.href}
    onClick={(e) => {
      e.preventDefault();
      if (isExternalUrl(props.href)) void openExternal(props.href).catch((err) => console.warn("open link:", err));
    }}
  />
);

/** react-markdown components: swap the default <pre> for CodeBlock. */
export const markdownComponents = { code: codeProps, pre: preProps, a: linkProps };

import { useEffect, useState, type ComponentProps } from "react";
import type { Highlighter } from "shiki";

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
      <span className="codeblock-lang">{lang}</span>
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

const codeProps = (props: ComponentProps<"code">) => {
  const { className, children } = props;
  const match = /language-(\w+)/.exec(className ?? "");
  const text = String(children ?? "").replace(/\n$/, "");
  const isBlock = Boolean(match) || text.includes("\n");
  if (!isBlock) return <code className={className}>{children}</code>;
  return <CodeBlock code={text} lang={match?.[1] ?? "text"} />;
};

const preProps = (props: ComponentProps<"pre">) => <>{props.children}</>;

/** react-markdown components: swap the default <pre> for CodeBlock. */
export const markdownComponents = { code: codeProps, pre: preProps };

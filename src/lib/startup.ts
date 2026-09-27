import { t } from "../../shared/i18n";

/**
 * Why the Rust shell could not start the sidecar (`StartupProblem` in src-tauri/src/lib.rs).
 * The shell sends facts; the sentence is built here, in the UI language. `from_env`: the only
 * node tried was `$PI_CODE_NODE`, so that variable is the thing to fix.
 */
export type StartupProblem =
  | { kind: "node_missing"; node: string; required: string; from_env?: boolean }
  | { kind: "node_too_old"; node: string; detected: string; required: string; from_env?: boolean }
  | { kind: "spawn"; error: string };

export function startupProblemText(p: StartupProblem): string {
  switch (p.kind) {
    case "node_missing":
      if (p.from_env)
        return t("PI_CODE_NODE wskazuje na {node}, a to nie jest działający Node.js. Proces pi potrzebuje Node {required} lub nowszego. Popraw PI_CODE_NODE (albo usuń tę zmienną, żeby użyć systemowego node) i uruchom Pi Code ponownie.", { node: p.node, required: p.required });
      return t("Brak Node.js (sprawdzono: {node}). Proces pi potrzebuje Node {required} lub nowszego. Zainstaluj Node, albo wskaż binarkę w zmiennej PI_CODE_NODE i uruchom Pi Code ponownie.", { node: p.node || "node", required: p.required });
    case "node_too_old":
      if (p.from_env)
        return t("PI_CODE_NODE wskazuje na Node {detected} ({node}), a proces pi potrzebuje Node {required} lub nowszego. Wskaż nowszą binarkę w PI_CODE_NODE (albo usuń tę zmienną) i uruchom Pi Code ponownie.", { node: p.node, detected: p.detected, required: p.required });
      return t("Znaleziono Node {detected} ({node}), a proces pi potrzebuje Node {required} lub nowszego. Zaktualizuj Node, albo wskaż nowszą binarkę w zmiennej PI_CODE_NODE i uruchom Pi Code ponownie.", { node: p.node, detected: p.detected, required: p.required });
    case "spawn":
      return t("Nie da się uruchomić procesu pi: {error}. Uruchom Pi Code ponownie.", { error: p.error });
  }
}

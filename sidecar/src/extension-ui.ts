import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PiEvent, UiAnswer, UiRequest } from "../../shared/protocol.js";

type DialogOpts = { signal?: AbortSignal; timeout?: number };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type UiRequestBody = WithoutId<UiRequest>;

/**
 * ctx.ui for extensions running inside the GUI: notify → a notice, setEditorText →
 * the composer, select/confirm/input/editor → a dialog card the user answers.
 * Everything that needs the TUI (widgets, footer, themes) is a no-op, like RPC mode.
 */
export class ExtensionDialogs {
  private pending = new Map<string, (a: UiAnswer) => void>();

  constructor(private readonly emit: (e: PiEvent) => void) {}

  /** Answer from the UI; unknown ids (timed out, cancelled) are ignored. */
  answer(id: string, answer: UiAnswer): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(answer);
  }

  /** Cancel every open dialog (run aborted, session swapped). */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.close(id);
  }

  /** Resolve as cancelled from this side and take the card down in the UI. */
  private close(id: string): void {
    if (!this.pending.has(id)) return;
    this.answer(id, { cancelled: true });
    this.emit({ kind: "ui_done", id });
  }

  private ask(request: UiRequestBody, opts?: DialogOpts): Promise<UiAnswer> {
    if (opts?.signal?.aborted) return Promise.resolve({ cancelled: true });
    const id = randomUUID();
    return new Promise((resolve) => {
      const onAbort = () => this.close(id);
      const timer = opts?.timeout ? setTimeout(onAbort, opts.timeout) : undefined;
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, (a) => {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve(a);
      });
      this.emit({ kind: "ui_request", request: { id, ...request } as UiRequest });
    });
  }

  /** `theme`: pi's TUI theme object — extensions may format text with it even without a TUI. */
  context(theme: unknown): ExtensionUIContext {
    const emit = this.emit;
    const text = (a: UiAnswer) => (a.cancelled || typeof a.value !== "string" ? undefined : a.value);
    const ui = {
      select: async (title: string, options: string[], opts?: DialogOpts) =>
        text(await this.ask({ method: "select", title, options }, opts)),
      confirm: async (title: string, message: string, opts?: DialogOpts) =>
        (await this.ask({ method: "confirm", title, message }, opts)).value === true,
      input: async (title: string, placeholder?: string, opts?: DialogOpts) =>
        text(await this.ask({ method: "input", title, placeholder }, opts)),
      editor: async (title: string, prefill?: string) => text(await this.ask({ method: "editor", title, prefill })),
      notify: (message: string, type?: "info" | "warning" | "error") =>
        emit({ kind: "notice", level: type ?? "info", text: message }),
      setEditorText: (value: string) => emit({ kind: "editor_text", text: value }),
      pasteToEditor: (value: string) => emit({ kind: "editor_text", text: value }),
      getEditorText: () => "",
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      get theme() {
        return theme;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "themes are not available in the GUI" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
    return ui as unknown as ExtensionUIContext;
  }
}

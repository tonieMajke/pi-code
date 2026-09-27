import type { GuiConfig, ToolPolicy } from "../../shared/protocol.js";
import { DEFAULT_CONSTITUTION } from "./constitution.js";
import { BrokenJsonError, readJsonObject, updateJsonObject } from "./json-file.js";

export const DEFAULT_CONFIG: GuiConfig = {
  constitution: { enabled: true, hard: true, text: "", maxNudges: 2 },
  tools: {},
  context: { elideOldToolOutput: true, elideAboveChars: 2000 },
  review: { enabled: true, model: "", minLines: 40 },
  escalation: { model: "", revert: true },
  sampling: {
    enabled: false,
    temperature: null,
    top_p: null,
    top_k: null,
    min_p: null,
    presence_penalty: null,
    repeat_penalty: null,
    reasoning_budget_tokens: 4096,
  },
  taste: { enabled: true, research: "auto", critic: true, criticModel: "", maxRounds: 2, requireAudit: true, criticSlot: null },
  memory: { enabled: true, learn: true },
  background: { localLimit: 2 },
  turnLimit: { enabled: true, steps: 10, minutes: 5 },
  extensions: { disabled: [] },
  onboarded: false,
};

/** Loaded with every request: the core loop plus cheap project navigation (pi-lens). */
const ALWAYS = new Set(["read", "bash", "edit", "write", "grep", "find", "project_report", "symbol_search", "look", "todo"]);
/** Useless or harmful here. */
const OFF = new Set(["powershell"]);

/** Built-in policy for tools the user has not set explicitly. */
export function defaultToolPolicy(name: string): ToolPolicy {
  if (ALWAYS.has(name)) return "always";
  if (OFF.has(name)) return "off";
  return "deferred";
}

type Section = Exclude<keyof GuiConfig, "tools" | "onboarded" | "terminal" | "terminalFork">;

/** GUI-owned config next to pi's settings.json (pi drops unknown keys from its own file). */
export class GuiConfigStore {
  private config: GuiConfig;
  /** The file was broken at start: running on defaults, nothing is written until it is fixed. */
  readonly broken: BrokenJsonError | null = null;

  constructor(private readonly file: string) {
    let raw: Partial<GuiConfig> = {};
    try {
      raw = readJsonObject(file) as Partial<GuiConfig>;
    } catch (e) {
      if (e instanceof BrokenJsonError) this.broken = e;
      /* unreadable — defaults */
    }
    this.config = {
      constitution: { ...DEFAULT_CONFIG.constitution, ...raw.constitution },
      tools: { ...raw.tools },
      context: { ...DEFAULT_CONFIG.context, ...raw.context },
      review: { ...DEFAULT_CONFIG.review, ...raw.review },
      escalation: { ...DEFAULT_CONFIG.escalation, ...raw.escalation },
      sampling: { ...DEFAULT_CONFIG.sampling, ...raw.sampling },
      taste: { ...DEFAULT_CONFIG.taste, ...raw.taste },
      memory: { ...DEFAULT_CONFIG.memory, ...raw.memory },
      background: { ...DEFAULT_CONFIG.background, ...raw.background },
      turnLimit: { ...DEFAULT_CONFIG.turnLimit, ...raw.turnLimit },
      extensions: { disabled: Array.isArray(raw.extensions?.disabled) ? raw.extensions.disabled.filter((n) => typeof n === "string") : [] },
      onboarded: raw.onboarded === true,
      terminal: raw.terminal,
      terminalFork: raw.terminalFork === true,
    };
  }

  get(): GuiConfig {
    return this.config;
  }

  get path(): string {
    return this.file;
  }

  /** Effective constitution text (empty custom text = the built-in default). */
  get constitutionText(): string {
    return this.config.constitution.text.trim() || DEFAULT_CONSTITUTION;
  }

  toolPolicy(name: string): ToolPolicy {
    return this.config.tools[name] ?? defaultToolPolicy(name);
  }

  update<K extends Section>(section: K, patch: Partial<GuiConfig[K]>): void {
    this.config = { ...this.config, [section]: { ...this.config[section], ...patch } };
    this.save();
  }

  /** The terminal command template; undefined = the default (konsole). */
  setTerminal(terminal: string | undefined): void {
    this.config = { ...this.config, terminal };
    this.save();
  }

  setTerminalFork(fork: boolean): void {
    this.config = { ...this.config, terminalFork: fork };
    this.save();
  }

  setOnboarded(): void {
    this.config = { ...this.config, onboarded: true };
    this.save();
  }

  setExtension(name: string, enabled: boolean): void {
    const rest = this.config.extensions.disabled.filter((n) => n !== name);
    this.update("extensions", { disabled: enabled ? rest : [...rest, name] });
  }

  extensionDisabled(name: string): boolean {
    return this.config.extensions.disabled.includes(name);
  }

  setToolPolicy(name: string, policy: ToolPolicy): void {
    const tools = { ...this.config.tools };
    if (policy === defaultToolPolicy(name)) delete tools[name];
    else tools[name] = policy;
    this.config = { ...this.config, tools };
    this.save();
  }

  /** Keys this store does not own (voice, anything newer) stay as they are in the file. */
  private save(): void {
    updateJsonObject(this.file, (raw) => ({ ...raw, ...this.config }));
  }
}

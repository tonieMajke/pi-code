import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GuiConfig, ToolPolicy } from "../../shared/protocol.js";
import { DEFAULT_CONSTITUTION } from "./constitution.js";

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
  turnLimit: { enabled: true, toolCalls: 10, minutes: 5 },
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

type Section = Exclude<keyof GuiConfig, "tools" | "onboarded">;

/** GUI-owned config next to pi's settings.json (pi drops unknown keys from its own file). */
export class GuiConfigStore {
  private config: GuiConfig;

  constructor(private readonly file: string) {
    let raw: Partial<GuiConfig> = {};
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GuiConfig>;
    } catch {
      /* missing or unreadable — defaults */
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
      onboarded: raw.onboarded === true,
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

  setOnboarded(): void {
    this.config = { ...this.config, onboarded: true };
    this.save();
  }

  setToolPolicy(name: string, policy: ToolPolicy): void {
    const tools = { ...this.config.tools };
    if (policy === defaultToolPolicy(name)) delete tools[name];
    else tools[name] = policy;
    this.config = { ...this.config, tools };
    this.save();
  }

  private save(): void {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
    } catch {
      /* new file */
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ ...raw, ...this.config }, null, 2)}\n`);
  }
}

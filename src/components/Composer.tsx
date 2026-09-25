import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Plug, ArrowUp, Brain, Check, ChevronDown, Clock, Cpu, Folder, FolderPlus, GitBranch, Paperclip, Square, X } from "lucide-react";
import type { Attachment, GuiConfig, ModelSummary, PermissionMode, PiSettings, SessionSummary, SettingsPatch, Usage } from "../../shared/protocol";
import { AddonsMenu } from "./AddonsMenu";
import { Menu, type MenuItem } from "./Menu";
import { t } from "../../shared/i18n";
import { basename, formatTokens } from "../lib/format";
import type { Outgoing } from "../lib/reducer";
import { MODES, modeInfo } from "../lib/modes";
import { dataUrl, imageFiles } from "../lib/images";
import { matchCommands, matchPicks, slashState, type PickItem, type SlashEntry, type SlashPick } from "../lib/slash";

const KIND_LABEL: Record<SlashEntry["kind"], string> = {
  gui: "",
  extension: "rozszerzenie",
  prompt: "szablon",
  skill: "skill",
  terminal: "tylko terminal",
};

const PICK_TITLE: Record<SlashPick, string> = {
  model: "Model tej sesji",
  thinking: "Poziom myślenia",
  mode: "Tryb uprawnień",
  fork: "Nowa sesja od wiadomości — wybierz, od której",
};

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  connected,
  pending,
  model,
  provider,
  models,
  onModel,
  onProviders,
  thinking,
  onThinking,
  cwd,
  branch,
  sessions,
  onProject,
  onPickFolder,
  usage,
  inputRef,
  hero,
  mode,
  onMode,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  blocked,
  files,
  onNeedFiles,
  commands,
  pickItems,
  onNeedPick,
  onCommand,
  addons,
  onAddonsPatch,
  onAddonsSettings,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  connected: boolean;
  pending: Outgoing[];
  model: string;
  provider: string;
  models: ModelSummary[];
  onModel: (m: ModelSummary) => void;
  /** Settings → model providers (add an API key or a server). */
  onProviders: () => void;
  /** null while settings haven't loaded yet, or the current model doesn't report thinking support. */
  thinking: PiSettings["thinking"] | null;
  onThinking: (level: string) => void;
  cwd: string;
  branch: string;
  sessions: SessionSummary[];
  onProject: (cwd: string) => void;
  /** Pick any folder (native dialog) and start a new session there. */
  onPickFolder: () => void;
  usage: Usage | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  hero: boolean;
  mode: PermissionMode;
  onMode: (m: PermissionMode) => void;
  attachments: Attachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (i: number) => void;
  /** An approval card is up — Enter belongs to it. */
  blocked: boolean;
  /** Project files for @-mentions (null until first requested). */
  files: string[] | null;
  onNeedFiles: () => void;
  /** Everything "/" offers: built-ins, pi's extension commands / templates / skills, terminal-only. */
  commands: SlashEntry[];
  /** Choices for a picker command; null = still loading. */
  pickItems: (pick: SlashPick) => PickItem[] | null;
  onNeedPick: (pick: SlashPick) => void;
  onCommand: (name: string, args: string) => void;
  /** Pi Code's additions (pi-gui.json); null until settings load. */
  addons?: GuiConfig | null;
  onAddonsPatch?: (patch: SettingsPatch) => void;
  onAddonsSettings?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  /** Text before the caret while it may be a command; null = popup closed. */
  const [slashBefore, setSlashBefore] = useState<string | null>(null);
  const [slashSel, setSlashSel] = useState(0);
  const slashPopRef = useRef<HTMLDivElement>(null);

  const slash = slashBefore === null ? null : slashState(slashBefore, commands);
  const slashList = slash?.kind === "list" ? matchCommands(commands, slash.query) : [];
  const pick = slash?.kind === "pick" ? slash.entry.pick! : null;
  const pickAll = pick ? pickItems(pick) : null;
  const pickList = slash?.kind === "pick" && pickAll ? matchPicks(pickAll, slash.query) : [];
  const slashCount = slash?.kind === "list" ? slashList.length : pickList.length;

  useEffect(() => {
    if (pick) onNeedPick(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per picker opened
  }, [pick]);

  // A freshly opened (or loaded) picker starts on the current choice.
  const pickReady = pickAll !== null;
  useEffect(() => {
    if (pick && pickReady) setSlashSel(Math.max(0, pickList.findIndex((p) => p.active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the picker opens or loads
  }, [pick, pickReady]);

  useEffect(() => {
    slashPopRef.current?.querySelector<HTMLElement>(".sel")?.scrollIntoView?.({ block: "nearest" });
  }, [slashSel, slash?.kind]);

  const setCaretText = (next: string) => {
    onChange(next);
    setSlashBefore(next);
    setSlashSel(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  /** Enter/click on a command: pickers and required arguments continue typing, the rest runs. */
  const chooseCommand = (c: SlashEntry, complete: boolean) => {
    if (complete || c.pick || c.args?.startsWith("<")) setCaretText(`/${c.name} `);
    else {
      setSlashBefore(null);
      onCommand(c.name, "");
    }
  };

  const choosePick = (item: PickItem) => {
    if (slash?.kind !== "pick") return;
    setSlashBefore(null);
    onCommand(slash.entry.name, item.key);
  };

  const suggestions = useMemo(() => {
    if (!mention || !files) return [];
    const q = mention.query.toLowerCase();
    const scored: [number, string][] = [];
    for (const f of files) {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      const score = !q ? 1 : base.startsWith(q) ? 3 : base.includes(q) ? 2 : lower.includes(q) ? 1 : 0;
      if (score) scored.push([score * 1000 - f.length, f]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, f]) => f);
  }, [mention, files]);

  /** Detect an "@query" token or a "/command" right before the caret. */
  const updateMention = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart);
    const maybeSlash = before.startsWith("/") && !before.includes("\n");
    setSlashBefore(maybeSlash ? before : null);
    if (maybeSlash && before !== slashBefore) setSlashSel(0);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m) {
      if (!files) onNeedFiles();
      setMention({ start: before.length - m[2].length - 1, query: m[2] });
      setMentionSel(0);
    } else setMention(null);
  };

  const pickMention = (path: string) => {
    const el = inputRef.current;
    if (!el || !mention) return;
    const end = el.selectionStart;
    const next = `${value.slice(0, mention.start)}@${path} ${value.slice(end)}`;
    onChange(next);
    setMention(null);
    const caret = mention.start + path.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };
  // Auto-grow the textarea up to the CSS max-height.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, inputRef]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    if (cwd) seen.set(cwd, "");
    for (const s of sessions) if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s.modified);
    return [...seen.keys()].slice(0, 12);
  }, [sessions, cwd]);

  const projectItems: MenuItem[] = projects.map((p) => ({
    key: p,
    label: (
      <span className="proj-item">
        <span className="proj-name">{basename(p)}</span>
        <span className="proj-path">{p.replace(/^\/home\/[^/]+/, "~")}</span>
      </span>
    ),
    hint: p === cwd ? <Check size={14} /> : undefined,
    active: p === cwd,
    onSelect: () => p !== cwd && onProject(p),
  }));
  projectItems.push({
    key: "__pick",
    label: (
      <span className="proj-item">
        <span className="proj-name">Inny folder…</span>
      </span>
    ),
    hint: <FolderPlus size={14} />,
    onSelect: onPickFolder,
  });

  const modelItems: MenuItem[] = models.map((m) => ({
    key: `${m.provider}/${m.id}`,
    label: m.id,
    hint: m.id === model && m.provider === provider ? <Check size={14} /> : formatTokens(m.contextWindow),
    active: m.id === model && m.provider === provider,
    onSelect: () => onModel(m),
  }));
  modelItems.push({
    key: "__providers",
    label: <span className="proj-item"><span className="proj-name">{t("Dostawcy modeli…")}</span></span>,
    hint: <Plug size={14} />,
    onSelect: onProviders,
  });

  const thinkingItems: MenuItem[] = (thinking?.available ?? []).map((l) => ({
    key: l,
    label: l,
    hint: l === thinking?.level ? <Check size={14} /> : undefined,
    active: l === thinking?.level,
    onSelect: () => onThinking(l),
  }));

  const pct =
    usage && usage.contextTokens !== null && usage.contextWindow > 0
      ? Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
      : null;

  const canSend = connected && (value.trim().length > 0 || attachments.length > 0) && !blocked;
  const current = modeInfo(mode);
  const ModeIcon = current.icon;
  const modeItems: MenuItem[] = MODES.map((m) => {
    const Icon = m.icon;
    return {
      key: m.id,
      label: (
        <span className={`mode-item mode-${m.id}`}>
          <Icon size={15} />
          <span className="mode-text">
            <span className="mode-name">{m.label}</span>
            <span className="mode-desc">{m.desc}</span>
          </span>
        </span>
      ),
      hint: m.id === mode ? <Check size={14} /> : undefined,
      active: m.id === mode,
      onSelect: () => onMode(m.id),
    };
  });

  return (
    <div className={`composer ${hero ? "centered" : ""}`}>
      {pending.length > 0 && (
        <div className="pending">
          {pending.map((p, i) => (
            <div className="pending-item" key={i}>
              <Clock size={13} />
              <span className="pending-text">
                {p.images?.length ? `[${p.images.length} obraz] ` : ""}
                {p.text}
              </span>
              <span className="pending-tag">czeka na koniec kroku</span>
            </div>
          ))}
        </div>
      )}
      <div className={`composer-box mode-${mode}`}>
        {slash && (
          <div className="mention-pop slash-pop" ref={slashPopRef}>
            {slash.kind === "pick" && <div className="slash-head">{PICK_TITLE[slash.entry.pick!]}</div>}
            {slash.kind === "pick" && !pickAll && <div className="s-empty">wczytywanie…</div>}
            {slashCount === 0 && (slash.kind === "list" || pickAll) && (
              <div className="s-empty">{slash.kind === "list" ? "brak takiej komendy" : "nic nie pasuje"}</div>
            )}
            {slash.kind === "list" &&
              slashList.map((c, i) => (
                <button
                  key={c.name}
                  className={`mention-item slash-item ${i === slashSel ? "sel" : ""} ${c.kind === "terminal" ? "dim" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    chooseCommand(c, false);
                  }}
                  onMouseEnter={() => setSlashSel(i)}
                >
                  <span className="slash-name">
                    /{c.name}
                    {c.args && <span className="slash-args"> {c.args}</span>}
                  </span>
                  <span className="slash-desc">{c.description}</span>
                  {KIND_LABEL[c.kind] && <span className={`slash-kind k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>}
                </button>
              ))}
            {slash.kind === "pick" &&
              pickList.map((p, i) => (
                <button
                  key={p.key}
                  className={`mention-item slash-item ${i === slashSel ? "sel" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choosePick(p);
                  }}
                  onMouseEnter={() => setSlashSel(i)}
                >
                  <span className="slash-pick-label">{p.label}</span>
                  {p.hint && <span className="slash-desc">{p.hint}</span>}
                  {p.active && <Check size={13} className="slash-check" />}
                </button>
              ))}
          </div>
        )}
        {mention && (
          <div className="mention-pop">
            {!files && <div className="s-empty">wczytywanie plików…</div>}
            {files && suggestions.length === 0 && <div className="s-empty">brak pasujących plików</div>}
            {suggestions.map((f, i) => {
              const slash = f.lastIndexOf("/");
              return (
                <button
                  key={f}
                  className={`mention-item ${i === mentionSel ? "sel" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(f);
                  }}
                  onMouseEnter={() => setMentionSel(i)}
                >
                  <span className="mention-name">{f.slice(slash + 1)}</span>
                  <span className="mention-dir">{slash > 0 ? f.slice(0, slash) : ""}</span>
                </button>
              );
            })}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a, i) => (
              <div className="thumb" key={i}>
                <img src={dataUrl(a)} alt="" />
                <button className="thumb-x" onClick={() => onRemoveAttachment(i)} title="Usuń">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            updateMention(e.target);
          }}
          onClick={(e) => updateMention(e.currentTarget)}
          onBlur={() =>
            setTimeout(() => {
              setMention(null);
              setSlashBefore(null);
            }, 150)
          }
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.items);
            if (files.length) {
              e.preventDefault();
              onAddFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (slash && e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setSlashBefore(null);
              return;
            }
            if (slash && slashCount > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const d = e.key === "ArrowDown" ? 1 : -1;
                setSlashSel((s) => (s + d + slashCount) % slashCount);
                return;
              }
              const sel = Math.min(slashSel, slashCount - 1);
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                if (slash.kind === "list") chooseCommand(slashList[sel], e.key === "Tab");
                else choosePick(pickList[sel]);
                return;
              }
            }
            if (mention && suggestions.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const d = e.key === "ArrowDown" ? 1 : -1;
                setMentionSel((s) => (s + d + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(suggestions[mentionSel]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder={
            blocked
              ? "Co model ma zrobić zamiast tego? (Enter = odmów z tym komentarzem)"
              : busy
                ? "Dopisz wskazówkę dla modelu (Enter = steering)…"
                : mode === "plan"
                  ? "Opisz, co zaplanować — model tylko czyta i analizuje"
                  : "Opisz zadanie albo zadaj pytanie"
          }
          rows={1}
          autoFocus
        />
        <div className="composer-bar">
          <button className="icon-btn attach" onClick={() => fileRef.current?.click()} title="Dołącz obraz (albo wklej / upuść)">
            <Paperclip size={15} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              onAddFiles(imageFiles(e.target.files));
              e.target.value = "";
            }}
          />
          <Menu
            className="chip-menu mode-menu"
            title="Tryb uprawnień · Shift+Tab przełącza"
            trigger={
              <span className={`chip mode-chip mode-${mode}`} title={current.desc}>
                <ModeIcon size={13} />
                <span>{current.label}</span>
                <ChevronDown size={12} className="chev" />
              </span>
            }
            items={modeItems}
          />
          <Menu
            className="chip-menu"
            title="Projekt (nowa sesja w katalogu)"
            trigger={
              <span className="chip" title={cwd}>
                <Folder size={13} />
                <span>{basename(cwd) || "projekt"}</span>
                <ChevronDown size={12} className="chev" />
              </span>
            }
            items={projectItems}
          />
          {branch && (
            <span className="chip static" title="gałąź git">
              <GitBranch size={13} />
              <span>{branch}</span>
            </span>
          )}
          {addons && onAddonsPatch && <AddonsMenu gui={addons} onPatch={onAddonsPatch} onSettings={() => onAddonsSettings?.()} />}
          <span className="bar-spacer" />
          {pct !== null && pct >= HANDOFF_AT && !busy && (
            <button
              className="chip ctx-suggest"
              title="Kontekst prawie pełny: model streści sesję, a streszczenie trafi do nowej (/handoff)"
              onClick={() => onCommand("handoff", "")}
            >
              Handoff?
            </button>
          )}
          {pct !== null && <ContextMenu usage={usage!} pct={pct} busy={busy} onCommand={onCommand} />}
          {thinking && thinking.available.length === 0 && thinking.server && (
            <span
              className="chip static thinking-chip"
              title="pi nie steruje myśleniem tego modelu — decyduje serwer llama.cpp (zwykle myśli). Budżet ustawisz w Ustawienia → Model i myślenie."
            >
              <Brain size={13} />
              <span>{thinking.server.budget ? `serwer · ≤${formatTokens(thinking.server.budget)}` : "serwer"}</span>
            </span>
          )}
          {thinking && thinking.available.length > 0 && (
            <Menu
              className="chip-menu"
              title="Poziom myślenia"
              trigger={
                <span className="chip thinking-chip">
                  <Brain size={13} />
                  <span>{thinking.level}</span>
                  <ChevronDown size={12} className="chev" />
                </span>
              }
              items={thinkingItems}
            />
          )}
          <Menu
            className="chip-menu"
            title="Model"
            trigger={
              <span className="chip model-chip" title={`${provider}/${model}`}>
                <Cpu size={13} />
                <span>{model || t("wybierz model")}</span>
                <ChevronDown size={12} className="chev" />
              </span>
            }
            items={modelItems}
          />
          {busy && !value.trim() && attachments.length === 0 ? (
            <button className="send stop" onClick={onStop} title="Przerwij (Esc)">
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button className="send" onClick={onSend} disabled={!canSend} title="Wyślij (Enter)">
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {!hero && (
        <div className="composer-hint">
          {connected ? (
            <>
              <kbd>Enter</kbd> wyślij · <kbd>Shift Enter</kbd> nowa linia · <kbd>/</kbd> komendy · <kbd>Shift Tab</kbd> tryb
              {busy && (
                <>
                  {" "}
                  · <kbd>Esc</kbd> przerwij
                </>
              )}
            </>
          ) : (
            <span className="warn">łączenie z pi…</span>
          )}
        </div>
      )}
    </div>
  );
}

const CTX_PARTS = [
  { key: "system", label: "Prompt systemowy", cls: "c-system" },
  { key: "tools", label: "Definicje narzędzi", cls: "c-tools" },
  { key: "messages", label: "Wiadomości", cls: "c-messages" },
] as const;

/** From here on a long session gets slow and forgetful: offer a fresh one. */
const HANDOFF_AT = 80;

/** Context ring; click opens the Claude-style breakdown popover. */
function ContextMenu({
  usage,
  pct,
  busy,
  onCommand,
}: {
  usage: Usage;
  pct: number;
  busy: boolean;
  onCommand: (name: string, args: string) => void;
}) {
  const used = usage.contextTokens ?? 0;
  const b = usage.breakdown;
  const width = (n: number) => `${(n / usage.contextWindow) * 100}%`;
  return (
    <Menu
      className="ctx-menu"
      items={[]}
      trigger={
        <span className="ctx" title="Kontekst — kliknij, żeby zobaczyć rozbicie">
          <svg viewBox="0 0 20 20" width="16" height="16">
            <circle cx="10" cy="10" r="8" className="ctx-bg" />
            <circle
              cx="10"
              cy="10"
              r="8"
              className="ctx-fg"
              strokeDasharray={`${(pct / 100) * 50.27} 50.27`}
              transform="rotate(-90 10 10)"
            />
          </svg>
          <span>{Math.round(pct)}%</span>
        </span>
      }
      footer={(close) => (
        <div className="ctx-pop">
          <div className="ctx-head">
            <span>
              <b>{Math.round(pct)}%</b> kontekstu zajęte
            </span>
            <span className="ctx-total">
              ~{formatTokens(used)} / {formatTokens(usage.contextWindow)}
            </span>
          </div>
          <div className="ctx-bar">
            {b ? (
              CTX_PARTS.map((p) => <span key={p.key} className={p.cls} style={{ width: width(b[p.key]) }} />)
            ) : (
              <span className="c-messages" style={{ width: width(used) }} />
            )}
          </div>
          {b &&
            CTX_PARTS.map((p) => (
              <div className="ctx-row" key={p.key}>
                <span className={`ctx-dot ${p.cls}`} />
                <span className="ctx-label">{p.label}</span>
                <span className="ctx-val">~{formatTokens(b[p.key])}</span>
              </div>
            ))}
          <div className="ctx-row free">
            <span className="ctx-dot" />
            <span className="ctx-label">Wolne</span>
            <span className="ctx-val">~{formatTokens(Math.max(0, usage.contextWindow - used))}</span>
          </div>
          <div className="ctx-actions">
            <button
              className="btn"
              disabled={busy}
              title="Streść starszą część rozmowy w tej sesji (/compact)"
              onClick={() => {
                close();
                onCommand("compact", "");
              }}
            >
              Kompaktuj
            </button>
            <button
              className="btn"
              disabled={busy}
              title="Model pisze podsumowanie, a ono trafia do pola nowej sesji — poprawiasz i wysyłasz (/handoff)"
              onClick={() => {
                close();
                onCommand("handoff", "");
              }}
            >
              Handoff → nowa sesja
            </button>
          </div>
        </div>
      )}
    />
  );
}

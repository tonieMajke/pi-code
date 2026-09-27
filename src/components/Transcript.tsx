import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ChevronRight, Pencil, Play, Scale, Undo2 } from "lucide-react";
import type { Attachment } from "../../shared/protocol";
import type { Msg, Part, RequestStats, ToolItem } from "../lib/reducer";
import { CopyButton, markdownComponents } from "../lib/code-block";
import { ToolCard } from "../lib/tool-card";
import { formatDuration, formatTokens } from "../lib/format";
import { dataUrl } from "../lib/images";
import { groupSteps, summarizeSteps, toBlocks, type Block } from "../lib/steps";
import { plural, t } from "../../shared/i18n";
import { turnTimeline, type Span, type SpanKind } from "../lib/timeline";
import { Lightbox } from "./Lightbox";

const REMARK = [remarkGfm, remarkBreaks];

export function Transcript({
  messages,
  cwd,
  now,
  awaiting,
  onExecutePlan,
  onEdit,
  onRestore,
  findTarget,
}: {
  messages: Msg[];
  cwd: string;
  now: number;
  /** Tool call ids parked on the permission gate. */
  awaiting: Set<string>;
  /** Set when the last turn is a finished plan-mode answer. */
  onExecutePlan?: () => void;
  /** Rewind to before the Nth-from-last user message (undefined while the model works). */
  onEdit?: (fromEnd: number) => void;
  /** Undo a run's file changes (undefined while the model works). */
  onRestore?: (checkpoint: string) => void;
  /** Block holding the current find hit — collapsed tools/thinking open for it. */
  findTarget?: { msg: number; part: number } | null;
}) {
  const last = messages.length - 1;
  // Position of each user message counted from the end — how the sidecar finds it on the branch.
  const fromEnd = new Map<number, number>();
  for (let i = last, n = 0; i >= 0; i--) if (messages[i].role === "user") fromEnd.set(i, n++);
  return (
    <>
      {messages.map((m, i) =>
        m.role === "user" ? (
          <UserMessage
            key={i}
            index={i}
            text={m.text}
            images={m.images}
            onEdit={onEdit && (() => onEdit(fromEnd.get(i)!))}
          />
        ) : m.role === "command" ? (
          <div className="cmd-line" key={i} data-msg={i} data-part={0}>
            <span className="cmd-prompt">›</span>
            <code>{m.text}</code>
          </div>
        ) : m.role === "info" ? (
          <InfoBlock key={i} index={i} text={m.text} level={m.level} />
        ) : (
          <AssistantTurn
            key={i}
            index={i}
            openPart={findTarget?.msg === i ? findTarget.part : -1}
            parts={m.parts}
            open={m.open}
            stats={m.stats}
            checkpoint={m.checkpoint}
            onRestore={onRestore}
            cwd={cwd}
            now={m.open ? now : 0}
            awaiting={awaiting}
            onExecutePlan={i === last ? onExecutePlan : undefined}
          />
        ),
      )}
    </>
  );
}

/** Command output / extension message: markdown, quieter than an answer. */
const InfoBlock = memo(function InfoBlock({ index, text, level }: { index: number; text: string; level: "info" | "warning" | "error" }) {
  return (
    <div className={`info-block info-${level}`} data-msg={index} data-part={0}>
      <ReactMarkdown remarkPlugins={REMARK} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const UserMessage = memo(function UserMessage({
  index,
  text,
  images,
  onEdit,
}: {
  index: number;
  text: string;
  images?: Attachment[];
  onEdit?: () => void;
}) {
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <div className="msg user" data-msg={index} data-part={0}>
      {onEdit && (
        <button className="edit-btn" onClick={onEdit} title={t("Edytuj i wyślij ponownie (stara gałąź zostaje w historii sesji)")}>
          <Pencil size={13} />
        </button>
      )}
      <div className="bubble">
        {images && images.length > 0 && (
          <div className="bubble-images">
            {images.map((a, i) => (
              <button key={i} className="bubble-image" onClick={() => setZoom(i)} title={t("Powiększ")}>
                <img src={dataUrl(a)} alt="" />
              </button>
            ))}
          </div>
        )}
        {zoom !== null && images?.[zoom] && <Lightbox img={images[zoom]} onClose={() => setZoom(null)} />}
        {text}
      </div>
    </div>
  );
});

function AssistantTurn({
  index,
  openPart,
  parts,
  open,
  stats,
  checkpoint,
  onRestore,
  cwd,
  now,
  awaiting,
  onExecutePlan,
}: {
  index: number;
  /** Part to show expanded (find hit), -1 = none. */
  openPart: number;
  parts: Part[];
  open: boolean;
  stats?: RequestStats[];
  checkpoint?: Extract<Msg, { role: "assistant" }>["checkpoint"];
  onRestore?: (checkpoint: string) => void;
  cwd: string;
  now: number;
  awaiting: Set<string>;
  onExecutePlan?: () => void;
}) {
  const [showTimeline, setShowTimeline] = useState(false);
  const blocks = groupSteps(toBlocks(parts), open, (i) => hiddenReply(parts, i));
  const text = parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const render = (b: Block, i: number): React.ReactNode => {
    if (b.kind === "steps") {
      return (
        <StepsRow key={i} parts={parts} indices={b.indices} forceOpen={b.indices.includes(openPart)}>
          {b.blocks.map(render)}
        </StepsRow>
      );
    }
    if (b.kind === "tools") {
      return (
        <div className="tool-group" key={i}>
          {b.tools.map(({ tool, index: p }) => (
            <ToolCard key={tool.id} tool={tool} cwd={cwd} now={now} awaiting={awaiting.has(tool.id)} part={p} forceOpen={openPart === p} />
          ))}
        </div>
      );
    }
    if (b.part.type === "notice") {
      return (
        <div className="guard-notice" key={i} data-part={b.index} title={t("Konstytucja odesłała model do pracy (Ustawienia → Konstytucja)")}>
          <Scale size={13} />
          <span>{b.part.text}</span>
        </div>
      );
    }
    if (b.part.type === "thinking") {
      return (
        <Thinking
          key={i}
          part={b.part}
          now={now}
          index={b.index}
          forceOpen={openPart === b.index}
          defaultOpen={hiddenReply(parts, b.index)}
        />
      );
    }
    return <Markdown key={i} text={b.part.text} index={b.index} />;
  };
  return (
    <div className="msg assistant" data-msg={index}>
      {blocks.map(render)}
      {!open && onExecutePlan && (
        <div className="plan-cta">
          <button className="btn primary" onClick={onExecutePlan}>
            <Play size={13} /> {t("Wykonaj plan")}
          </button>
          <span>{t("przełączy na Auto-edycje i każe modelowi zacząć")}</span>
        </div>
      )}
      {!open && Boolean(text || stats?.length || checkpoint) && (
        <div className="msg-actions">
          {text && <CopyButton text={text} />}
          {checkpoint && <RestoreButton checkpoint={checkpoint} onRestore={onRestore} />}
          {stats && stats.length > 0 && <TurnStats stats={stats} onClick={() => setShowTimeline(!showTimeline)} open={showTimeline} />}
        </div>
      )}
      {!open && showTimeline && <TurnTimeline parts={parts} stats={stats} />}
    </div>
  );
}

/** A finished chain of steps as one row: "▸ 6 kroków: 3 polecenia, 1 edycja · 2 min". */
function StepsRow({ parts, indices, forceOpen, children }: { parts: Part[]; indices: number[]; forceOpen: boolean; children: React.ReactNode }) {
  const [userOpen, setOpen] = useState(false);
  const open = userOpen || forceOpen;
  const sum = summarizeSteps(parts, indices);
  return (
    <div className={`steps ${open ? "open" : ""}`} data-part={indices[0]}>
      <button className="steps-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className="tool-chevron" />
        <span className="steps-label">{sum.label}</span>
        {sum.errors > 0 && <span className="steps-err">· {plural(sum.errors, ["{n} błąd", "{n} błędy", "{n} błędów"], ["{n} error", "{n} errors"])}</span>}
        {sum.ms !== null && <span className="steps-time">· {formatDuration(sum.ms)}</span>}
      </button>
      {open && <div className="steps-body">{children}</div>}
    </div>
  );
}

function RestoreButton({
  checkpoint,
  onRestore,
}: {
  checkpoint: NonNullable<Extract<Msg, { role: "assistant" }>["checkpoint"]>;
  onRestore?: (checkpoint: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  const n = checkpoint.files.length;
  const list = checkpoint.files.slice(0, 20).join("\n") + (n > 20 ? `\n${t("… i {n} więcej", { n: n - 20 })}` : "");
  if (checkpoint.restored) {
    return (
      <span className="restore-btn done" title={list}>
        <Undo2 size={13} /> {plural(n, ["cofnięto zmiany w {n} pliku", "cofnięto zmiany w {n} plikach", "cofnięto zmiany w {n} plikach"], ["reverted changes in {n} file", "reverted changes in {n} files"])}
      </span>
    );
  }
  return (
    <button
      className={`restore-btn ${armed ? "armed" : ""}`}
      disabled={!onRestore}
      title={`${armed ? t("Kliknij jeszcze raz, żeby cofnąć") : t("Przywróć pliki do stanu sprzed tej odpowiedzi")}:\n${list}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        onRestore?.(checkpoint.id);
      }}
      onMouseLeave={() => setArmed(false)}
    >
      <Undo2 size={13} />
      {armed ? t("na pewno? kliknij jeszcze raz") : t("Cofnij zmiany plików ({n})", { n })}
    </button>
  );
}

const Markdown = memo(function Markdown({ text, index }: { text: string; index: number }) {
  return (
    <div className="md" data-part={index}>
      <ReactMarkdown remarkPlugins={REMARK} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Reasoning that talks about the user's question ("The user is asking me…", "Użytkownik pyta…"). */
const ADDRESSES_USER = /\b(the user('s)? (is )?(asking|asks|asked|wants to know|question)|u[żz]ytkownik (pyta|chce wiedzie[cć]))/i;

/**
 * The model answered the user in its reasoning and went straight to a tool call — the answer
 * would stay collapsed and the user sees only tool cards. Keep that reasoning open.
 */
export function hiddenReply(parts: Part[], index: number): boolean {
  const part = parts[index];
  if (part?.type !== "thinking" || !ADDRESSES_USER.test(part.text)) return false;
  if (parts.slice(0, index).some((p) => p.type !== "thinking")) return false; // not the reply's start
  const next = parts.slice(index + 1).find((p) => p.type !== "thinking");
  return next?.type === "tool";
}

function Thinking({
  part,
  now,
  index,
  forceOpen,
  defaultOpen = false,
}: {
  part: Extract<Part, { type: "thinking" }>;
  now: number;
  index: number;
  forceOpen: boolean;
  /** Start expanded (the user can still collapse it). */
  defaultOpen?: boolean;
}) {
  const active = part.end === undefined && part.start !== undefined && now > 0;
  const [userOpen, setOpen] = useState<boolean | null>(null);
  const open = (userOpen ?? defaultOpen) || forceOpen;
  const secs =
    part.start !== undefined ? formatDuration((part.end ?? (now || part.start)) - part.start) : "";
  const label = active ? t("Myśli… {secs}", { secs }) : secs && part.end !== part.start ? t("Myślał {secs}", { secs }) : t("Przemyślenia");
  return (
    <div className={`thinking ${open || active ? "open" : ""} ${active ? "active" : ""}`} data-part={index}>
      <button className="thinking-row" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="tool-chevron" />
        <span className={active ? "shimmer" : ""}>{label}</span>
      </button>
      {(open || active) && (
        // column-reverse keeps the newest lines visible while the block is capped
        <div className="thinking-text">
          <div>{part.text.trim()}</div>
        </div>
      )}
    </div>
  );
}

/** "↑ 20,6 tys. · PP 2 766 t/s · ↓ 167 · 105 t/s" — summed over the turn's requests. */
function TurnStats({ stats, onClick, open }: { stats: RequestStats[]; onClick: () => void; open: boolean }) {
  const sum = (f: (s: RequestStats) => number) => stats.reduce((a, s) => a + f(s), 0);
  const promptTokens = sum((s) => s.promptTokens);
  const promptMs = sum((s) => s.promptMs);
  const cache = Math.max(...stats.map((s) => s.cacheTokens));
  const genTokens = sum((s) => s.genTokens);
  const genMs = sum((s) => s.genMs);
  const pp = promptMs > 0 ? (promptTokens / promptMs) * 1000 : 0;
  const tg = genMs > 0 ? (genTokens / genMs) * 1000 : 0;
  const detail = stats
    .map(
      (s, i) =>
        `#${i + 1}: ` +
        t("prompt {tok} tok (cache {cache}) w {time} → {speed} t/s", { tok: s.promptTokens, cache: s.cacheTokens, time: formatDuration(s.promptMs), speed: Math.round(s.promptPerSec) }) +
        " · " +
        t("gen {tok} tok w {time} → {speed} t/s", { tok: s.genTokens, time: formatDuration(s.genMs), speed: Math.round(s.genPerSec) }),
    )
    .join("\n");
  return (
    <button className={`turn-stats ${open ? "on" : ""}`} onClick={onClick} aria-expanded={open} title={`${plural(stats.length, ["{n} zapytanie do modelu", "{n} zapytania do modelu", "{n} zapytań do modelu"], ["{n} model request", "{n} model requests"])} — ${t("kliknij: oś czasu tury")}\n${detail}`}>
      <span>↑ {formatTokens(promptTokens)}</span>
      {cache > 0 && <span className="dim">cache {formatTokens(cache)}</span>}
      {/* tiny cached prompts are all overhead — their "speed" is noise */}
      {pp > 0 && promptTokens >= 512 && <span>PP {Math.round(pp)} t/s</span>}
      <span>↓ {formatTokens(genTokens)}</span>
      {tg > 0 && <span>{tg.toFixed(1).replace(".", ",")} t/s</span>}
    </button>
  );
}

/** Timeline lane names, in the language the interface has right now. */
const spanName = (k: SpanKind): string =>
  k === "prompt" ? t("przetwarzanie promptu") : k === "gen" ? t("generowanie") : k === "tool" ? t("narzędzia") : t("czekanie na zgodę");

/** Where the turn's time went, on two lanes: the model and the tools. */
function TurnTimeline({ parts, stats }: { parts: Part[]; stats?: RequestStats[] }) {
  const tl = turnTimeline(parts, stats);
  if (!tl) return null;
  const span = Math.max(1, tl.end - tl.start);
  const lane = (spans: Span[]) => (
    <div className="tl-lane">
      {spans.map((s, i) => (
        <span
          key={i}
          className={`tl-span tl-${s.kind}`}
          style={{ left: `${((s.start - tl.start) / span) * 100}%`, width: `max(2px, ${((s.end - s.start) / span) * 100}%)` }}
          title={`${spanName(s.kind)} · ${s.label} · ${formatDuration(s.end - s.start)}`}
        />
      ))}
    </div>
  );
  const kinds = (["prompt", "gen", "tool", "wait"] as SpanKind[]).filter((k) => tl.totals[k] > 0);
  return (
    <div className="timeline">
      {tl.end > tl.start && (
        <div className="tl-lanes">
          <span className="tl-name">{t("model")}</span>
          {lane(tl.model)}
          {tl.tools.length > 0 && <span className="tl-name">{t("narzędzia")}</span>}
          {tl.tools.length > 0 && lane(tl.tools)}
        </div>
      )}
      <div className="tl-legend">
        {kinds.map((k) => (
          <span key={k}>
            <i className={`tl-dot tl-${k}`} />
            {spanName(k)} {formatDuration(tl.totals[k])}
          </span>
        ))}
        {tl.end > tl.start && <span className="tl-total">{t("cała tura")} {formatDuration(tl.end - tl.start)}</span>}
        {!(tl.end > tl.start) && <span className="tl-total">{t("bez osi czasu — tura sprzed tej wersji")}</span>}
      </div>
    </div>
  );
}

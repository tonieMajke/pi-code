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

const REMARK = [remarkGfm, remarkBreaks];

export function Transcript({
  messages,
  cwd,
  now,
  awaiting,
  onExecutePlan,
  onEdit,
  onRestore,
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
            text={m.text}
            images={m.images}
            onEdit={onEdit && (() => onEdit(fromEnd.get(i)!))}
          />
        ) : (
          <AssistantTurn
            key={i}
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

const UserMessage = memo(function UserMessage({
  text,
  images,
  onEdit,
}: {
  text: string;
  images?: Attachment[];
  onEdit?: () => void;
}) {
  return (
    <div className="msg user">
      {onEdit && (
        <button className="edit-btn" onClick={onEdit} title="Edytuj i wyślij ponownie (stara gałąź zostaje w historii sesji)">
          <Pencil size={13} />
        </button>
      )}
      <div className="bubble">
        {images && images.length > 0 && (
          <div className="bubble-images">
            {images.map((a, i) => (
              <a key={i} href={dataUrl(a)} target="_blank" rel="noreferrer">
                <img src={dataUrl(a)} alt="" />
              </a>
            ))}
          </div>
        )}
        {text}
      </div>
    </div>
  );
});

type Block = { kind: "part"; part: Exclude<Part, { type: "tool" }> } | { kind: "tools"; tools: ToolItem[] };

/** Consecutive tool calls render as one compact group (Claude Code style). */
function toBlocks(parts: Part[]): Block[] {
  const blocks: Block[] = [];
  for (const p of parts) {
    if (p.type === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.tools.push(p.tool);
      else blocks.push({ kind: "tools", tools: [p.tool] });
    } else {
      blocks.push({ kind: "part", part: p });
    }
  }
  return blocks;
}

function AssistantTurn({
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
  const blocks = toBlocks(parts);
  const text = parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  return (
    <div className="msg assistant">
      {blocks.map((b, i) => {
        if (b.kind === "tools") {
          return (
            <div className="tool-group" key={i}>
              {b.tools.map((t) => (
                <ToolCard key={t.id} tool={t} cwd={cwd} now={now} awaiting={awaiting.has(t.id)} />
              ))}
            </div>
          );
        }
        if (b.part.type === "notice") {
          return (
            <div className="guard-notice" key={i} title="Konstytucja odesłała model do pracy (Ustawienia → Konstytucja)">
              <Scale size={13} />
              <span>{b.part.text}</span>
            </div>
          );
        }
        if (b.part.type === "thinking") {
          return <Thinking key={i} part={b.part} now={now} />;
        }
        return <Markdown key={i} text={b.part.text} />;
      })}
      {!open && onExecutePlan && (
        <div className="plan-cta">
          <button className="btn primary" onClick={onExecutePlan}>
            <Play size={13} /> Wykonaj plan
          </button>
          <span>przełączy na Auto-edycje i każe modelowi zacząć</span>
        </div>
      )}
      {!open && Boolean(text || stats?.length || checkpoint) && (
        <div className="msg-actions">
          {text && <CopyButton text={text} />}
          {checkpoint && <RestoreButton checkpoint={checkpoint} onRestore={onRestore} />}
          {stats && stats.length > 0 && <TurnStats stats={stats} />}
        </div>
      )}
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
  const list = checkpoint.files.slice(0, 20).join("\n") + (n > 20 ? `\n… i ${n - 20} więcej` : "");
  if (checkpoint.restored) {
    return (
      <span className="restore-btn done" title={list}>
        <Undo2 size={13} /> cofnięto zmiany w {n} {n === 1 ? "pliku" : "plikach"}
      </span>
    );
  }
  return (
    <button
      className={`restore-btn ${armed ? "armed" : ""}`}
      disabled={!onRestore}
      title={`${armed ? "Kliknij jeszcze raz, żeby cofnąć" : "Przywróć pliki do stanu sprzed tej odpowiedzi"}:\n${list}`}
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
      {armed ? "na pewno? kliknij jeszcze raz" : `Cofnij zmiany plików (${n})`}
    </button>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function Thinking({ part, now }: { part: Extract<Part, { type: "thinking" }>; now: number }) {
  const active = part.end === undefined && part.start !== undefined && now > 0;
  const [open, setOpen] = useState(false);
  const secs =
    part.start !== undefined ? formatDuration((part.end ?? (now || part.start)) - part.start) : "";
  const label = active ? `Myśli… ${secs}` : secs && part.end !== part.start ? `Myślał ${secs}` : "Przemyślenia";
  return (
    <div className={`thinking ${open || active ? "open" : ""} ${active ? "active" : ""}`}>
      <button className="thinking-row" onClick={() => setOpen((o) => !o)}>
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
function TurnStats({ stats }: { stats: RequestStats[] }) {
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
        `#${i + 1}: prompt ${s.promptTokens} tok (cache ${s.cacheTokens}) w ${formatDuration(s.promptMs)} → ` +
        `${Math.round(s.promptPerSec)} t/s · gen ${s.genTokens} tok w ${formatDuration(s.genMs)} → ${Math.round(s.genPerSec)} t/s`,
    )
    .join("\n");
  return (
    <span className="turn-stats" title={`${stats.length} zapytań do modelu\n${detail}`}>
      <span>↑ {formatTokens(promptTokens)}</span>
      {cache > 0 && <span className="dim">cache {formatTokens(cache)}</span>}
      {/* tiny cached prompts are all overhead — their "speed" is noise */}
      {pp > 0 && promptTokens >= 512 && <span>PP {Math.round(pp)} t/s</span>}
      <span>↓ {formatTokens(genTokens)}</span>
      {tg > 0 && <span>{tg.toFixed(1).replace(".", ",")} t/s</span>}
    </span>
  );
}

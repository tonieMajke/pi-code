import { useEffect, useState, type ReactNode } from "react";

export function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="s-row">
      <div className="s-row-text">
        <div className="s-row-label">{label}</div>
        {desc && <div className="s-row-desc">{desc}</div>}
      </div>
      <div className="s-row-ctl">{children}</div>
    </div>
  );
}

export function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={value} disabled={disabled} className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}

export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Commits on blur / Enter so every keystroke doesn't rewrite settings.json. */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      className="s-input num"
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

export function TextField({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onCommit(draft.trim());
  return (
    <input
      className="s-input"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}


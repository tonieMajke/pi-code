import { useEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem = {
  key: string;
  label: ReactNode;
  hint?: ReactNode;
  active?: boolean;
  onSelect: () => void;
};

/** Minimal popover menu: trigger button + list, closes on outside click / Esc. */
export function Menu({
  trigger,
  items,
  title,
  placement = "up",
  className = "",
  footer,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  title?: string;
  placement?: "up" | "down";
  className?: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector(".menu-item.active")?.scrollIntoView({ block: "nearest" });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`menu ${className}`} ref={ref}>
      <button type="button" className={`menu-trigger ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div className={`menu-pop ${placement}`} role="menu">
          {title && <div className="menu-title">{title}</div>}
          <div className="menu-items">
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={`menu-item ${it.active ? "active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                <span className="menu-label">{it.label}</span>
                {it.hint && <span className="menu-hint">{it.hint}</span>}
              </button>
            ))}
          </div>
          {footer && <div className="menu-footer">{footer}</div>}
        </div>
      )}
    </div>
  );
}

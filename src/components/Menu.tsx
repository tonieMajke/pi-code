import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export type MenuItem = {
  key: string;
  label: ReactNode;
  hint?: ReactNode;
  active?: boolean;
  onSelect: () => void;
  /** Section header shown above the first item of each run of the same group. */
  group?: string;
  /** Text the search box matches (the label when it is a string). */
  search?: string;
  /** Always listed, whatever the search says (e.g. "Model providers…"). */
  keep?: boolean;
};

/** Every word of the query must appear in the item's text or its group. */
export function filterMenuItems(items: MenuItem[], query: string): MenuItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => {
    if (it.keep) return true;
    const hay = `${it.search ?? (typeof it.label === "string" ? it.label : "")} ${it.group ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Minimal popover menu: trigger button + list, closes on outside click / Esc. */
export function Menu({
  trigger,
  items,
  title,
  placement = "up",
  className = "",
  footer,
  searchPlaceholder,
  emptyText,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  title?: string;
  placement?: "up" | "down";
  className?: string;
  /** A function gets close() — for footers with their own buttons. */
  footer?: ReactNode | ((close: () => void) => ReactNode);
  /** Shows a search box above the items (arrows + Enter pick, Esc clears it first). */
  searchPlaceholder?: string;
  /** Shown when the search leaves nothing to pick. */
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hl, setHl] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const shown = searchPlaceholder ? filterMenuItems(items, query) : items;
  const picks = shown.filter((it) => !it.keep || !query);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHl(-1);
    }
  }, [open]);
  // Typing puts the first match under Enter.
  useEffect(() => setHl(query ? 0 : -1), [query]);
  useEffect(() => {
    if (hl >= 0) ref.current?.querySelector(".menu-item.hl")?.scrollIntoView?.({ block: "nearest" });
  }, [hl]);

  const pick = (it: MenuItem) => {
    setOpen(false);
    it.onSelect();
  };
  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!picks.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setHl((h) => (h < 0 ? (d > 0 ? 0 : picks.length - 1) : (h + d + picks.length) % picks.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = picks[hl >= 0 ? hl : 0];
      if (it) pick(it);
    }
  };

  // A tall pop-up near the window edge scrolls instead of going off-screen.
  useLayoutEffect(() => {
    const pop = open ? ref.current?.querySelector<HTMLElement>(".menu-pop") : null;
    if (!pop) return;
    const r = pop.getBoundingClientRect();
    const room = Math.floor(placement === "up" ? r.bottom - 8 : window.innerHeight - r.top - 8);
    if (r.height <= room) return;
    // With a search box only the list scrolls: the box and the footer stay in view.
    const list = searchPlaceholder ? pop.querySelector<HTMLElement>(".menu-items") : null;
    if (list) {
      list.style.maxHeight = `${Math.max(list.clientHeight - (r.height - room), 120)}px`;
      return;
    }
    pop.style.maxHeight = `${Math.max(room, 120)}px`;
    pop.style.overflowY = "auto";
  }, [open, placement, searchPlaceholder]);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector(".menu-item.active")?.scrollIntoView({ block: "nearest" });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        const box = ref.current?.querySelector<HTMLInputElement>(".menu-search");
        if (box?.value) setQuery("");
        else setOpen(false);
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
          {searchPlaceholder && (
            <input
              className="menu-search"
              autoFocus
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
          )}
          <div className="menu-items">
            {shown.map((it, i) => (
              <Fragment key={it.key}>
                {it.group && it.group !== shown[i - 1]?.group && <div className="menu-group">{it.group}</div>}
                <button
                  type="button"
                  role="menuitem"
                  className={`menu-item ${it.active ? "active" : ""} ${picks[hl] === it ? "hl" : ""}`}
                  onClick={() => pick(it)}
                >
                  <span className="menu-label">{it.label}</span>
                  {it.hint && <span className="menu-hint">{it.hint}</span>}
                </button>
              </Fragment>
            ))}
            {query && picks.length === 0 && emptyText && <div className="menu-empty">{emptyText}</div>}
          </div>
          {footer && <div className="menu-footer">{typeof footer === "function" ? footer(() => setOpen(false)) : footer}</div>}
        </div>
      )}
    </div>
  );
}

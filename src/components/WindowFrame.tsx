import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

const EDGES: [ResizeDirection, string][] = [
  ["North", "n"],
  ["South", "s"],
  ["East", "e"],
  ["West", "w"],
  ["NorthEast", "ne"],
  ["NorthWest", "nw"],
  ["SouthEast", "se"],
  ["SouthWest", "sw"],
];

/**
 * Frame for the undecorated Tauri window: invisible resize grips on the edges
 * (GTK gives none without decorations) and `html.win-max` while maximized, so
 * the CSS can drop the rounded corners and the grips.
 */
export function WindowFrame() {
  useEffect(() => {
    const w = getCurrentWindow();
    const root = document.documentElement;
    root.classList.add("win-frameless");
    const sync = () =>
      void w
        .isMaximized()
        .then((m) => root.classList.toggle("win-max", m))
        .catch(() => undefined);
    sync();
    const off = w.onResized(sync);
    return () => {
      root.classList.remove("win-frameless", "win-max");
      void off.then((f) => f());
    };
  }, []);

  return (
    <div className="win-grips" aria-hidden>
      {EDGES.map(([dir, cls]) => (
        <div
          key={cls}
          className={`win-grip ${cls}`}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow().startResizeDragging(dir);
          }}
        />
      ))}
    </div>
  );
}

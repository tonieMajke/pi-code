import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

/** Min / max / close for the undecorated Tauri window (title bar lives in the topbar). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => void w.isMaximized().then(setMaximized).catch(() => undefined);
    sync();
    const off = w.onResized(sync);
    return () => void off.then((f) => f());
  }, []);
  const w = () => getCurrentWindow();
  return (
    <div className="win-controls">
      <button className="win-btn" onClick={() => void w().minimize()} title="Minimalizuj">
        <Minus size={15} />
      </button>
      <button className="win-btn" onClick={() => void w().toggleMaximize()} title={maximized ? "Przywróć" : "Maksymalizuj"}>
        {maximized ? <Copy size={12} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" onClick={() => void w().close()} title="Zamknij">
        <X size={16} />
      </button>
    </div>
  );
}

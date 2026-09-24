import { Cpu } from "lucide-react";
import type { RouterStatus } from "../../shared/protocol";
import { Menu } from "./Menu";

const gb = (mib: number) => (mib / 1024).toFixed(1).replace(".", ",");

const STATUS_PL: Record<string, string> = {
  loaded: "załadowany",
  loading: "ładuje się",
  sleeping: "uśpiony",
  unloaded: "",
};

/** Topbar pill: VRAM across GPUs; popover lists GPUs and router models. */
export function GpuStatus({ status, model }: { status: RouterStatus | null; model: string }) {
  if (!status || (status.gpus.length === 0 && status.models.length === 0)) return null;
  const used = status.gpus.reduce((a, g) => a + g.memUsed, 0);
  const total = status.gpus.reduce((a, g) => a + g.memTotal, 0);
  const util = status.gpus.length ? Math.max(...status.gpus.map((g) => g.util)) : 0;
  const active = status.models.filter((m) => m.status !== "unloaded");
  return (
    <Menu
      className="gpu-menu"
      placement="down"
      title="GPU i router llama.cpp"
      trigger={
        <span className={`gpu-pill ${util > 50 ? "hot" : ""}`} title="VRAM (wszystkie GPU)">
          <Cpu size={13} />
          {total > 0 ? `${gb(used)} / ${gb(total)} GB` : "router"}
          {util > 0 && <span className="gpu-util">{util}%</span>}
        </span>
      }
      items={[]}
      footer={
        <div className="gpu-pop">
          {status.gpus.map((g) => (
            <div className="gpu-row" key={g.index}>
              <div className="gpu-line">
                <span>
                  GPU {g.index} · {g.name.replace(/^NVIDIA (GeForce )?/, "")}
                </span>
                <span className="dim">
                  {gb(g.memUsed)} / {gb(g.memTotal)} GB · {g.util}%
                </span>
              </div>
              <span className="gpu-bar">
                <span style={{ width: `${(g.memUsed / g.memTotal) * 100}%` }} />
              </span>
            </div>
          ))}
          {status.models.length > 0 && (
            <>
              <div className="menu-title">Modele w routerze</div>
              {(active.length ? active : status.models.slice(0, 0)).map((m) => (
                <div className={`gpu-model ${m.id === model ? "current" : ""}`} key={m.id}>
                  <span className={`gpu-dot s-${m.status}`} />
                  <span className="gpu-model-id">{m.id}</span>
                  <span className="dim">{STATUS_PL[m.status] ?? m.status}</span>
                </div>
              ))}
              {active.length === 0 && <div className="s-empty">żaden model nie jest załadowany</div>}
              <div className="gpu-foot dim">{status.models.length - active.length} modeli niezaładowanych</div>
            </>
          )}
        </div>
      }
    />
  );
}

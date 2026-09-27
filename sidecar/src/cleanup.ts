import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CleanupScan, OrphanSidecar, SessionSummary, TestSession } from "../../shared/protocol.js";

const run = promisify(execFile);

/** The e2e smoke test's prompt (dev/e2e-smoke.test.ts). */
const E2E_PROMPT = "Odpowiedz dokładnie jednym słowem: gotowe";
/** One-word checks people and scripts send to see that a model answers at all. */
const PING = /^(odpowiedz|powiedz|napisz|reply|say|answer)\b[^\n]{0,40}\b(jednym słowem|jednym zdaniem|one word|ok)\b|^(powiedz|say) ok\.?$/i;

/** Why a session looks like a test run (and not work), or null. Deleting is still the user's call. */
export function testReason(s: SessionSummary): string | null {
  if (s.cwd === "/tmp" || s.cwd.startsWith("/tmp/")) return "katalog tymczasowy";
  const first = s.firstMessage.trim();
  if (first === E2E_PROMPT) return "test e2e";
  if (s.messageCount <= 4 && PING.test(first)) return "krótki test modelu";
  return null;
}

export function testSessions(all: SessionSummary[]): TestSession[] {
  return all.flatMap((s) => {
    const reason = testReason(s);
    return reason ? [{ path: s.path, cwd: s.cwd, title: s.name || s.firstMessage.slice(0, 80), modified: s.modified, reason }] : [];
  });
}

interface Proc {
  pid: number;
  ppid: number;
  started: string;
  args: string;
}

const SIDECAR = /sidecar\/src\/main\.ts|sidecar\/dist\/main\.mjs|(^|\s)(\S*\/)?pnpm(\.cjs)? sidecar(\s|$)/;

/**
 * Sidecars nobody talks to any more: the topmost sidecar process of a tree (pnpm → tsx → node in
 * dev, node in the AppImage) whose parent is init or the user's systemd — the app or bridge that
 * started it is gone. This sidecar and its own ancestors never count.
 */
export function orphanSidecars(procs: Proc[], self: number): OrphanSidecar[] {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const mine = new Set<number>();
  for (let p = by.get(self); p; p = by.get(p.ppid)) {
    mine.add(p.pid);
    if (p.ppid === p.pid) break;
  }
  const isSidecar = (p: Proc) => SIDECAR.test(p.args);
  const out: OrphanSidecar[] = [];
  for (const p of procs) {
    if (!isSidecar(p) || mine.has(p.pid)) continue;
    const parent = by.get(p.ppid);
    if (parent && isSidecar(parent)) continue; // not the top of its tree
    const orphaned = p.ppid === 1 || (parent !== undefined && /(^|\/)systemd(\s|$)/.test(parent.args));
    if (!orphaned) continue;
    const pids = [p.pid];
    for (let i = 0; i < pids.length; i++) for (const c of procs) if (c.ppid === pids[i] && isSidecar(c)) pids.push(c.pid);
    out.push({ pid: p.pid, pids, started: p.started, cmd: p.args.slice(0, 200) });
  }
  return out;
}

export async function listProcs(): Promise<Proc[]> {
  const { stdout } = await run("ps", ["-eo", "pid=,ppid=,lstart=,args="], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  return stdout.split("\n").flatMap((line) => {
    // lstart is five words: "Sun Sep 27 12:26:28 2026"
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), started: m[3], args: m[4] }] : [];
  });
}

export async function scanCleanup(sessions: SessionSummary[]): Promise<CleanupScan> {
  const orphans = orphanSidecars(await listProcs().catch(() => []), process.pid);
  const pids = orphans.flatMap((o) => o.pids);
  return { sessions: testSessions(sessions), orphans, killCommand: pids.length ? `kill ${pids.join(" ")}` : "" };
}

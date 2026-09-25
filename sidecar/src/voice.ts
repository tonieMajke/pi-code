import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { VoiceConfig, VoiceInput, VoiceKeySource, VoiceProvider, VoiceState } from "../../shared/protocol.js";
import { t } from "../../shared/i18n.js";

/**
 * Dictation: the microphone is recorded here, not in the webview — WebKitGTK's getUserMedia
 * needs a permission handler Tauri does not wire up, and the browser build would ask every
 * time. PipeWire (pw-record) first, then PulseAudio and ALSA. 16 kHz mono s16 is what
 * Whisper-class models resample to anyway, so the upload stays small (32 kB/s).
 * Transcription: any OpenAI-compatible POST /audio/transcriptions (cortecs.ai, OpenRouter,
 * OpenAI, Groq, a local whisper server).
 */

export const RATE = 16000;
/** OpenRouter and OpenAI cap uploads at 25 MB: 16 kHz s16 mono ≈ 13 min, stop a bit earlier. */
export const MAX_SECONDS = 12 * 60;
const MIN_SECONDS = 0.4;
/**
 * Recording is float32: a good interface in a quiet room stays below one 16-bit step and
 * would read as exact zeros in s16, while in float a raw mic always hisses. Exact 0.0 = nothing
 * came through: a muted device, or a noise gate / DeepFilterNet (EasyEffects) in silence —
 * so it only means "silent so far", never "broken".
 */
export function isDead(floatPeak: number): boolean {
  return floatPeak === 0;
}

/** float32le → s16le for the upload and the meter; also the float peak. */
export function f32ToS16(f: Buffer): { pcm: Buffer; peak: number } {
  const n = Math.floor(f.length / 4);
  const out = Buffer.alloc(n * 2);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = f.readFloatLE(i * 4);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return { pcm: out, peak };
}

type Preset = { label: string; baseUrl: string; model: string; env?: string; keyUrl?: string; needsKey: boolean };

export const VOICE_PRESETS: Record<VoiceProvider, Preset> = {
  cortecs: {
    label: "cortecs.ai",
    baseUrl: "https://api.cortecs.ai/v1",
    model: "whisper-large-v3",
    env: "CORTECS_API_KEY",
    keyUrl: "https://cortecs.ai",
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/whisper-1",
    env: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/settings/keys",
    needsKey: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-transcribe",
    env: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    env: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
  },
  custom: { label: "Własny serwer", baseUrl: "http://localhost:8000/v1", model: "whisper-large-v3", needsKey: false },
};

export const DEFAULT_VOICE: VoiceConfig = { enabled: true, provider: "cortecs", baseUrl: "", model: "", language: "pl", device: "" };

/** Empty baseUrl/model = the preset's. */
export function effective(c: VoiceConfig): { baseUrl: string; model: string } {
  const p = VOICE_PRESETS[c.provider];
  return { baseUrl: (c.baseUrl.trim() || p.baseUrl).replace(/\/+$/, ""), model: c.model.trim() || p.model };
}

// ---------- audio ----------

/** Loudness 0..1 of a chunk of s16le samples, on a curve that makes speech fill the meter. */
export function level(pcm: Buffer): { level: number; peak: number } {
  const n = Math.floor(pcm.length / 2);
  if (!n) return { level: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / n) / 32768;
  // dBFS: -60 (room) … -10 (loud speech) → 0..1.
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  return { level: Math.max(0, Math.min(1, (db + 60) / 50)), peak };
}

export function wav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** device: a PipeWire/Pulse source name, "" = the system default (ALSA can't pick those). */
const RECORDERS: { bin: string; args: (device: string) => string[] }[] = [
  {
    bin: "pw-record",
    args: (d) => ["--raw", "--rate", String(RATE), "--channels", "1", "--format", "f32", "--latency", "40ms", ...(d ? ["--target", d] : []), "-"],
  },
  { bin: "parecord", args: (d) => ["--raw", "--format=float32le", `--rate=${RATE}`, "--channels=1", "--latency-msec=40", ...(d ? [`--device=${d}`] : [])] },
  { bin: "arecord", args: () => ["-q", "-t", "raw", "-f", "FLOAT_LE", "-r", String(RATE), "-c", "1"] },
];

/** Microphones (no monitors of outputs), default first. Empty when pactl is missing. */
export function listInputs(): { name: string; label: string; isDefault: boolean }[] {
  const r = spawnSync("pactl", ["-f", "json", "list", "sources"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return [];
  const def = spawnSync("pactl", ["get-default-source"], { encoding: "utf8", timeout: 3000 }).stdout?.trim() ?? "";
  try {
    const list = JSON.parse(r.stdout) as { name: string; description?: string; monitor_source?: string }[];
    return list
      .filter((s) => !s.monitor_source && !s.name.endsWith(".monitor"))
      .map((s) => ({ name: s.name, label: s.description || s.name, isDefault: s.name === def }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  } catch {
    return [];
  }
}

/** Record `ms` from one input and measure it — which microphone is actually alive. */
export function probeInput(device: string, ms = 1200): Promise<{ level: number; peak: number; dead: boolean }> {
  const r = findRecorder();
  if (!r) return Promise.resolve({ level: 0, peak: 0, dead: true });
  return new Promise((done) => {
    const proc = spawn(r.bin, r.args(device), { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    proc.stdout!.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => done({ level: 0, peak: 0, dead: true }));
    proc.on("close", () => {
      // Skip the first 200 ms: some devices start with a click or zeros.
      const { pcm, peak: fpeak } = f32ToS16(Buffer.concat(chunks).subarray(RATE * 4 * 0.2));
      // Loudest 100 ms window, so one word during the probe shows up.
      let best = { level: 0, peak: 0 };
      const win = RATE * 2 * 0.1;
      for (let i = 0; i + win <= pcm.length; i += win) {
        const l = level(pcm.subarray(i, i + win));
        if (l.level > best.level || l.peak > best.peak) best = { level: Math.max(best.level, l.level), peak: Math.max(best.peak, l.peak) };
      }
      done({ ...best, dead: isDead(fpeak) });
    });
    setTimeout(() => proc.kill("SIGINT"), ms);
  });
}

let recorderCache: (typeof RECORDERS)[number] | null | undefined;
function findRecorder(): (typeof RECORDERS)[number] | null {
  if (recorderCache !== undefined) return recorderCache;
  recorderCache = RECORDERS.find((r) => spawnSync("which", [r.bin], { stdio: "ignore" }).status === 0) ?? null;
  return recorderCache;
}

/**
 * Whisper fills silence and noise with subtitle credits it saw in training. When the whole
 * result is one of those, nothing was said.
 */
const HALLUCINATIONS = [
  /^napisy (stworzone|wykonane) przez społeczność amara\.org\.?$/i,
  /^(dziękuję( za uwagę| za obejrzenie)?|dzięki za obejrzenie)[.!]*$/i,
  /^thank(s| you)( for watching)?[.!]*$/i,
  /^(subtitles|napisy) by .*$/i,
  /^\.+$/,
];

export function cleanTranscript(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return HALLUCINATIONS.some((re) => re.test(s)) ? "" : s;
}

// ---------- keys ----------

/** Secrets stay out of pi-gui.json (the UI gets that file whole) — own file, 0600. */
export class VoiceKeys {
  constructor(
    private readonly file: string,
    private readonly authFile: string,
    private readonly mowaFile = `${homedir()}/.config/mowa/config.toml`,
  ) {}

  private read(): Partial<Record<VoiceProvider, string>> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Partial<Record<VoiceProvider, string>>;
    } catch {
      return {};
    }
  }

  set(provider: VoiceProvider, key: string): void {
    const keys = this.read();
    if (key.trim()) keys[provider] = key.trim();
    else delete keys[provider];
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  /** Stored here → env → the same service's key already on this machine (pi, MowaWszędzie). */
  resolve(provider: VoiceProvider): { key: string; source: VoiceKeySource } {
    const stored = this.read()[provider];
    if (stored) return { key: stored, source: "stored" };
    const env = VOICE_PRESETS[provider].env;
    if (env && process.env[env]) return { key: process.env[env]!, source: "env" };
    if (provider === "openrouter" || provider === "openai" || provider === "groq") {
      try {
        const auth = JSON.parse(readFileSync(this.authFile, "utf8")) as Record<string, { type?: string; key?: string }>;
        const k = auth[provider]?.type === "api_key" ? auth[provider]?.key : undefined;
        if (k && !k.startsWith("!") && !/^[A-Z_]+$/.test(k)) return { key: k, source: "pi" };
      } catch {
        /* no auth.json */
      }
    }
    if (provider === "cortecs") {
      try {
        const m = /^\s*cortecs_api_key\s*=\s*"([^"]+)"/m.exec(readFileSync(this.mowaFile, "utf8"));
        if (m?.[1]) return { key: m[1], source: "mowa" };
      } catch {
        /* no MowaWszędzie */
      }
    }
    return { key: "", source: "none" };
  }
}

// ---------- config ----------

/** The "voice" section of pi-gui.json — usable before a session exists (no init needed). */
export class VoiceStore {
  constructor(private readonly file: string) {}

  get(): VoiceConfig {
    try {
      const raw = (JSON.parse(readFileSync(this.file, "utf8")) as { voice?: Partial<VoiceConfig> }).voice ?? {};
      const c = { ...DEFAULT_VOICE, ...raw };
      if (!(c.provider in VOICE_PRESETS)) c.provider = DEFAULT_VOICE.provider;
      return c;
    } catch {
      return { ...DEFAULT_VOICE };
    }
  }

  update(patch: Partial<VoiceConfig>): VoiceConfig {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
    } catch {
      /* new file */
    }
    const next = { ...this.get(), ...patch };
    // Switching provider starts from that provider's defaults.
    if (patch.provider && patch.baseUrl === undefined) next.baseUrl = "";
    if (patch.provider && patch.model === undefined) next.model = "";
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ ...raw, voice: next }, null, 2)}\n`);
    return next;
  }
}

// ---------- transcription ----------

export async function transcribe(
  audio: Buffer,
  c: VoiceConfig,
  key: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const { baseUrl, model } = effective(c);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "mowa.wav");
  form.append("model", model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (c.language && c.language !== "auto") form.append("language", c.language);
  // cortecs.ai sometimes picks translate on its own (Polish came back in English) — the
  // undocumented field fixes it. Others don't need it; OpenRouter rejects unknown fields.
  if (c.provider === "cortecs") form.append("task", "transcribe");
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  if (c.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/pi-code";
    headers["X-Title"] = "Pi Code";
  }
  const url = `${baseUrl}/audio/transcriptions`;
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", headers, body: form, signal: signal ?? AbortSignal.timeout(90_000) });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new Error(t("serwer transkrypcji nie odpowiada ({url}): {err}", { url, err: err instanceof Error ? err.message : String(err) }));
  }
  const body = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(t("serwer transkrypcji odrzucił klucz API ({status})", { status: res.status }));
  if (!res.ok) {
    let msg = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; detail?: string; message?: string };
      msg = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.detail ?? j.message ?? msg;
    } catch {
      /* plain text */
    }
    throw new Error(t("transkrypcja nie wyszła ({status}): {msg}", { status: res.status, msg }));
  }
  try {
    const j = JSON.parse(body) as { text?: string };
    return cleanTranscript(j.text ?? "");
  } catch {
    return cleanTranscript(body);
  }
}

// ---------- the recorder ----------

type Emit = (e: { level: number; live: boolean }) => void;

export class Dictation {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private peak = 0;
  private pending = Buffer.alloc(0);
  private cap: NodeJS.Timeout | null = null;
  private failure: string | null = null;
  private transcribing: AbortController | null = null;

  constructor(
    readonly store: VoiceStore,
    readonly keys: VoiceKeys,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get recording(): boolean {
    return this.proc !== null;
  }

  state(): VoiceState {
    const config = this.store.get();
    const providers = (Object.keys(VOICE_PRESETS) as VoiceProvider[]).map((id) => {
      const p = VOICE_PRESETS[id];
      return { id, label: p.label, baseUrl: p.baseUrl, model: p.model, keyUrl: p.keyUrl ?? "", needsKey: p.needsKey, keySource: this.keys.resolve(id).source };
    });
    const r = findRecorder();
    return { config, providers, recorder: r?.bin ?? "", ready: Boolean(r) && (!VOICE_PRESETS[config.provider].needsKey || this.keys.resolve(config.provider).source !== "none") };
  }

  start(emit: Emit): { recorder: string; maxSeconds: number } {
    if (this.proc) return { recorder: "", maxSeconds: MAX_SECONDS };
    const c = this.store.get();
    if (VOICE_PRESETS[c.provider].needsKey && this.keys.resolve(c.provider).source === "none")
      throw new Error(t("brak klucza API dla {name} — Ustawienia → Dyktowanie", { name: VOICE_PRESETS[c.provider].label }));
    const r = findRecorder();
    if (!r) throw new Error(t("nie ma czym nagrywać — zainstaluj pipewire (pw-record), pulseaudio-utils albo alsa-utils"));
    this.chunks = [];
    this.bytes = 0;
    this.peak = 0;
    this.pending = Buffer.alloc(0);
    this.failure = null;
    const proc = spawn(r.bin, r.args(c.device), { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    // ~25 meter updates a second.
    const frame = (RATE * 4) / 25;
    proc.stdout!.on("data", (d: Buffer) => {
      this.pending = Buffer.concat([this.pending, d]);
      while (this.pending.length >= frame) {
        const { pcm, peak } = f32ToS16(this.pending.subarray(0, frame));
        this.pending = this.pending.subarray(frame);
        this.chunks.push(pcm);
        this.bytes += pcm.length;
        if (peak > this.peak) this.peak = peak;
        emit({ level: level(pcm).level, live: !isDead(this.peak) });
      }
    });
    let err = "";
    proc.stderr!.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-500)));
    proc.on("error", (e) => (this.failure = e.message));
    proc.on("exit", (code, sig) => {
      if (code && !sig && !this.failure) this.failure = err.trim() || `${r.bin}: ${code}`;
    });
    this.cap = setTimeout(() => this.halt(), MAX_SECONDS * 1000);
    return { recorder: r.bin, maxSeconds: MAX_SECONDS };
  }

  /** Stop recording; resolves once the recorder has flushed. */
  private async halt(): Promise<void> {
    const proc = this.proc;
    if (this.cap) clearTimeout(this.cap);
    this.cap = null;
    if (!proc) return;
    this.proc = null;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((done) => {
      const kill = setTimeout(() => proc.kill("SIGKILL"), 1500);
      proc.once("close", () => {
        clearTimeout(kill);
        done();
      });
      proc.kill("SIGINT");
    });
  }

  /** Every microphone with a short measurement of what it hears (parallel, ~1.3 s). */
  async inputs(): Promise<VoiceInput[]> {
    if (this.proc) return listInputs().map((i) => ({ ...i, level: -1, peak: -1, dead: false }));
    const list = listInputs();
    const measured = await Promise.all(list.map((i) => probeInput(i.name)));
    return list.map((i, k) => ({ ...i, ...measured[k] }));
  }

  cancel(): void {
    this.transcribing?.abort();
    void this.halt();
    this.chunks = [];
  }

  async stop(): Promise<{ text: string; seconds: number; ms: number }> {
    await this.halt();
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    const seconds = pcm.length / (RATE * 2);
    if (this.failure && seconds < MIN_SECONDS) throw new Error(t("nagrywanie nie ruszyło: {err}", { err: this.failure }));
    if (seconds < MIN_SECONDS) throw new Error(t("za krótkie nagranie"));
    if (isDead(this.peak)) throw new Error(t("na wejściu była sama cisza — nic się nie nagrało (odszumianie wycina ciszę do zera, więc mów wyraźnie albo zmień wejście w Ustawienia → Dyktowanie)"));
    const c = this.store.get();
    const { key } = this.keys.resolve(c.provider);
    const started = Date.now();
    this.transcribing = new AbortController();
    try {
      const text = await transcribe(wav(pcm), c, key, this.fetchFn, AbortSignal.any([this.transcribing.signal, AbortSignal.timeout(90_000)]));
      return { text, seconds, ms: Date.now() - started };
    } finally {
      this.transcribing = null;
    }
  }

  dispose(): void {
    this.cancel();
  }
}

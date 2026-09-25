import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, X } from "lucide-react";
import type { VoiceState } from "../../shared/protocol";
import type { PiRequest } from "../lib/transport";
import { formatClock, onVoiceLevel } from "../lib/voice-meter";
import { t } from "../../shared/i18n";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/**
 * Dictation state machine: idle → starting → recording → transcribing → idle.
 * Recording happens in the sidecar; this only drives it and hands the text to `onText`.
 */
export function useDictation({
  request,
  onText,
  onError,
  onSetup,
}: {
  request: PiRequest;
  onText: (text: string) => void;
  onError: (msg: string) => void;
  /** No key or no recorder yet: open the settings section. */
  onSetup: () => void;
}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [since, setSince] = useState(0);
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** Bumped on cancel: a stop reply that arrives afterwards is dropped. */
  const genRef = useRef(0);

  const refresh = useCallback(() => {
    request<VoiceState>({ cmd: "voice_get" }).then(setVoice, () => undefined);
  }, [request]);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    let st = voice;
    if (!st?.ready) {
      st = await request<VoiceState>({ cmd: "voice_get" }).catch(() => null);
      if (st) setVoice(st);
    }
    if (st && !st.ready) {
      onError(st.recorder ? t("Dyktowanie: dodaj klucz API w Ustawienia → Dyktowanie.") : t("Dyktowanie: brak programu do nagrywania (pw-record, parecord albo arecord)."));
      onSetup();
      return;
    }
    setPhase("starting");
    try {
      await request({ cmd: "voice_start" });
      setSince(Date.now());
      setPhase("recording");
    } catch (e) {
      setPhase("idle");
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [voice, request, onError, onSetup]);

  const stop = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    const gen = genRef.current;
    setPhase("transcribing");
    try {
      const r = await request<{ text: string }>({ cmd: "voice_stop" });
      if (gen !== genRef.current) return;
      if (r.text) onText(r.text);
      else onError(t("Nic nie usłyszałem — spróbuj jeszcze raz, bliżej mikrofonu."));
    } catch (e) {
      if (gen === genRef.current) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === genRef.current) setPhase("idle");
    }
  }, [request, onText, onError]);

  const cancel = useCallback(() => {
    if (phaseRef.current === "idle") return;
    genRef.current++;
    setPhase("idle");
    request({ cmd: "voice_cancel" }).catch(() => undefined);
  }, [request]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "recording") void stop();
  }, [start, stop]);

  // While dictating: Enter = done, Esc = throw away (before the app's Esc = stop the model).
  useEffect(() => {
    if (phase !== "recording" && phase !== "transcribing") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter" && !e.shiftKey && phase === "recording") {
        e.preventDefault();
        e.stopPropagation();
        void stop();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel, stop]);

  // Leaving the app mid-recording must not leave the mic open.
  useEffect(() => () => void request({ cmd: "voice_cancel" }).catch(() => undefined), [request]);

  return { phase, since, voice, refresh, start, stop, cancel, toggle };
}

export function MicButton({ phase, ready, onClick }: { phase: DictationPhase; ready: boolean; onClick: () => void }) {
  return (
    <button
      className={`mic-btn ${phase !== "idle" ? "on" : ""} ${ready ? "" : "unset"}`}
      onClick={onClick}
      title={ready ? t("Dyktuj (Ctrl+M)") : t("Dyktowanie — skonfiguruj dostawcę transkrypcji")}
      aria-label={t("Dyktuj")}
    >
      <Mic size={16} />
    </button>
  );
}

/**
 * Replaces the composer bar while dictating: live waveform, clock, cancel and done.
 * While transcribing, the recorded wave freezes and a light sweeps over it.
 */
export function DictationBar({
  phase,
  since,
  maxSeconds = 12 * 60,
  provider,
  onCancel,
  onDone,
  onSetup,
  boxRef,
}: {
  phase: DictationPhase;
  since: number;
  maxSeconds?: number;
  provider: string;
  onCancel: () => void;
  onDone: () => void;
  /** Open Settings → Dyktowanie (the microphone choice). */
  onSetup: () => void;
  /** The composer box: its glow follows the voice. */
  boxRef: React.RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Survives the recording → transcribing switch, so the frozen wave stays on screen. */
  const barsRef = useRef<number[]>([]);
  const [now, setNow] = useState(Date.now());
  /** Loudest level heard so far: still exactly 0 after a second = the input is dead. */
  const [heard, setHeard] = useState(false);
  useEffect(() => {
    if (phase === "starting") setHeard(false);
    return onVoiceLevel((_, live) => {
      if (live) setHeard(true);
    });
  }, [phase]);
  const recording = phase === "recording" || phase === "starting";

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (phase === "starting") barsRef.current = [];
    let smooth = 0;
    let raf = 0;
    let count = 200;
    // One bar per level event (~25/s): the wave keeps time even when frames are throttled.
    const off = onVoiceLevel((l) => {
      if (!recording) return;
      barsRef.current.push(l);
      if (barsRef.current.length > count) barsRef.current = barsRef.current.slice(-count);
    });
    const colors = () => {
      const cs = getComputedStyle(canvas);
      return { accent: cs.getPropertyValue("--accent").trim() || "#d97757", faint: cs.getPropertyValue("--faint").trim() || "#6f6d66" };
    };
    let palette = colors();
    let frames = 0;
    const draw = (ts: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      if (++frames % 60 === 0) palette = colors();
      const gap = 3;
      const bw = 3;
      count = Math.max(1, Math.floor(w / (bw + gap)));
      const bars = barsRef.current;
      smooth += ((bars[bars.length - 1] ?? 0) - smooth) * 0.25;
      boxRef.current?.style.setProperty("--voice", recording && !reduced ? smooth.toFixed(3) : "0");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;
      const offset = w - bars.length * (bw + gap);
      // Resting dots where nothing was recorded yet.
      ctx.fillStyle = palette.faint;
      for (let x = w - count * (bw + gap); x < offset; x += bw + gap) ctx.fillRect(x, mid - 1, bw, 2);
      const sweep = phase === "transcribing" ? ((ts / 1100) % 1.4) - 0.2 : -1;
      bars.forEach((v, i) => {
        const x = offset + i * (bw + gap);
        const bh = Math.max(2, Math.pow(v, 1.3) * (h - 4));
        const age = (bars.length - 1 - i) / count;
        let alpha = recording ? 1 - age * 0.55 : 0.45;
        if (sweep > -1) {
          const d = Math.abs(x / w - sweep);
          alpha = Math.max(alpha, 1 - d * 5);
        }
        ctx.globalAlpha = Math.max(0.15, Math.min(1, alpha));
        ctx.fillStyle = palette.accent;
        const r = Math.min(bw / 2, bh / 2);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, bw, bh, r);
        else ctx.rect(x, mid - bh / 2, bw, bh);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      off();
      boxRef.current?.style.setProperty("--voice", "0");
    };
  }, [recording, phase, boxRef]);

  const elapsed = since ? (now - since) / 1000 : 0;
  const nearLimit = elapsed > maxSeconds - 30;
  // Noise suppression (EasyEffects) gives exact zeros in silence: only hint after a while.
  const silent = phase === "recording" && !heard && elapsed > 4;
  return (
    <div className={`dictation-bar ${phase}`} role="status" aria-live="polite">
      <button className="icon-btn dict-cancel" onClick={onCancel} title={t("Odrzuć nagranie (Esc)")}>
        <X size={16} />
      </button>
      <span className="dict-dot" aria-hidden />
      <div className="dict-wave-wrap">
        <canvas ref={canvasRef} className="dict-wave" aria-hidden />
        {silent && (
          <button className="dict-silent" onClick={onSetup}>
            {t("Na wejściu cisza — mów albo zmień wejście")}
          </button>
        )}
      </div>
      <span className={`dict-clock ${nearLimit ? "warn" : ""}`}>
        {phase === "transcribing" ? t("Transkrypcja · {name}", { name: provider }) : formatClock(elapsed)}
      </span>
      <button className="send dict-done" onClick={onDone} disabled={phase !== "recording"} title={t("Gotowe — wstaw tekst (Enter)")}>
        {phase === "transcribing" || phase === "starting" ? <Loader2 size={16} className="spin" /> : <Check size={16} strokeWidth={2.6} />}
      </button>
    </div>
  );
}

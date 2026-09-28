import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE, VoiceKeys, VoiceStore, cleanTranscript, level, transcribe, wav } from "./voice.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-gui-voice-"));

function tone(amp: number, n = 1600): Buffer {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * amp), i * 2);
  return b;
}

describe("level", () => {
  it("silence is 0, speech-loud is near the top, clipping is capped", () => {
    expect(level(Buffer.alloc(3200)).level).toBe(0);
    expect(level(tone(30)).level).toBeLessThan(0.2);
    expect(level(tone(8000)).level).toBeGreaterThan(0.6);
    expect(level(tone(32767)).level).toBe(1);
    expect(level(tone(8000)).peak).toBeGreaterThan(7000);
  });
});

describe("wav", () => {
  it("writes a 16 kHz mono PCM header around the samples", () => {
    const w = wav(tone(1000, 100));
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.toString("ascii", 8, 12)).toBe("WAVE");
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt16LE(22)).toBe(1);
    expect(w.readUInt32LE(40)).toBe(200);
    expect(w.length).toBe(244);
  });
});

describe("cleanTranscript", () => {
  it("drops Whisper's silence hallucinations, keeps real text", () => {
    expect(cleanTranscript("Napisy stworzone przez społeczność Amara.org")).toBe("");
    expect(cleanTranscript(" Dziękuję. ")).toBe("");
    expect(cleanTranscript("Dziękuję, że poprawiłeś ten test")).toBe("Dziękuję, że poprawiłeś ten test");
    expect(cleanTranscript("  dwa \n słowa ")).toBe("dwa słowa");
  });
});

describe("transcribe", () => {
  function fake(status: number, body: string) {
    const calls: { url: string; headers: Record<string, string>; form: FormData }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, form: init.body as FormData });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it("cortecs: preset URL, model, language and the task field", async () => {
    const { fn, calls } = fake(200, JSON.stringify({ text: " Cześć, świecie " }));
    const text = await transcribe(wav(tone(1000)), { ...DEFAULT_VOICE, language: "pl" }, "k1", fn);
    expect(text).toBe("Cześć, świecie");
    expect(calls[0].url).toBe("https://api.cortecs.ai/v1/audio/transcriptions");
    expect(calls[0].headers.Authorization).toBe("Bearer k1");
    expect(calls[0].form.get("model")).toBe("whisper-large-v3");
    expect(calls[0].form.get("language")).toBe("pl");
    expect(calls[0].form.get("task")).toBe("transcribe");
    expect((calls[0].form.get("file") as File).type).toBe("audio/wav");
  });

  it("openrouter: no task field, auto language omitted, custom model and URL", async () => {
    const { fn, calls } = fake(200, JSON.stringify({ text: "ok" }));
    await transcribe(wav(tone(1000)), { ...DEFAULT_VOICE, provider: "openrouter", language: "auto", model: "mistralai/voxtral-mini", baseUrl: "https://x.test/v1/" }, "k", fn);
    expect(calls[0].url).toBe("https://x.test/v1/audio/transcriptions");
    expect(calls[0].form.get("task")).toBeNull();
    expect(calls[0].form.get("language")).toBeNull();
    expect(calls[0].form.get("model")).toBe("mistralai/voxtral-mini");
    expect(calls[0].headers["X-Title"]).toBe("Pi Code");
  });

  it("custom server without a key sends no Authorization", async () => {
    const { fn, calls } = fake(200, "{\"text\":\"a\"}");
    await transcribe(wav(tone(1000)), { ...DEFAULT_VOICE, provider: "custom" }, "", fn);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("errors say what the server said", async () => {
    await expect(transcribe(wav(tone(10)), DEFAULT_VOICE, "bad", fake(401, "{}").fn)).rejects.toThrow(/401/);
    await expect(transcribe(wav(tone(10)), DEFAULT_VOICE, "k", fake(400, JSON.stringify({ error: { message: "model not found" } })).fn)).rejects.toThrow(
      /model not found/,
    );
  });
});

describe("VoiceKeys", () => {
  it("stored beats env beats pi/mowa; file is 0600; empty key removes", () => {
    const dir = tmp();
    const auth = join(dir, "auth.json");
    const mowa = join(dir, "mowa.toml");
    writeFileSync(auth, JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-pi" } }));
    writeFileSync(mowa, 'backend = "cortecs"\ncortecs_api_key = "mowa-key"\n');
    const keys = new VoiceKeys(join(dir, "keys.json"), auth, mowa);
    const envBefore = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.CORTECS_API_KEY;
    try {
      expect(keys.resolve("openrouter")).toEqual({ key: "sk-or-pi", source: "pi" });
      expect(keys.resolve("cortecs")).toEqual({ key: "mowa-key", source: "mowa" });
      expect(keys.resolve("groq").source).toBe("none");
      process.env.OPENROUTER_API_KEY = "sk-env";
      expect(keys.resolve("openrouter").source).toBe("env");
      keys.set("openrouter", " sk-mine ");
      expect(keys.resolve("openrouter")).toEqual({ key: "sk-mine", source: "stored" });
      expect(statSync(join(dir, "keys.json")).mode & 0o777).toBe(0o600);
      keys.set("openrouter", "");
      expect(keys.resolve("openrouter").source).toBe("env");
    } finally {
      if (envBefore === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = envBefore;
    }
  });
});

describe("VoiceStore", () => {
  it("keeps the rest of pi-gui.json and resets URL/model on provider change", () => {
    const file = join(tmp(), "pi-gui.json");
    writeFileSync(file, JSON.stringify({ memory: { enabled: false } }));
    const store = new VoiceStore(file);
    expect(store.get()).toEqual(DEFAULT_VOICE);
    store.update({ model: "whisper-x", language: "en" });
    store.update({ provider: "openrouter" });
    const raw = JSON.parse(readFileSync(file, "utf8")) as { memory: unknown; voice: { model: string; language: string; provider: string } };
    expect(raw.memory).toEqual({ enabled: false });
    expect(raw.voice).toMatchObject({ provider: "openrouter", model: "", language: "en" });
  });
});

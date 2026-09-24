import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addEndpoint, endpointId, normalizeBaseUrl, probeEndpoint, removeEndpoint } from "./providers";

describe("endpoints", () => {
  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl("localhost:8000")).toBe("http://localhost:8000/v1");
    expect(normalizeBaseUrl("http://gpu-box:8000/")).toBe("http://gpu-box:8000/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("http://host/openai/v1/models")).toBe("http://host/openai/v1");
  });

  it("makes provider ids", () => {
    expect(endpointId("vLLM na serwerze")).toBe("vllm-na-serwerze");
    expect(endpointId("  LM Studio ")).toBe("lm-studio");
    expect(endpointId("!!!")).toBe("custom");
  });

  it("writes and removes models.json entries, keeping the rest", () => {
    const file = join(mkdtempSync(join(tmpdir(), "models-")), "models.json");
    writeFileSync(file, JSON.stringify({ providers: { ollama: { baseUrl: "x", models: [] } }, other: 1 }));
    const id = addEndpoint(file, { name: "vLLM", baseUrl: "localhost:8000", models: ["qwen", "llama"], contextWindows: { qwen: 32768 } });
    const data = JSON.parse(readFileSync(file, "utf8"));
    expect(id).toBe("vllm");
    expect(data.other).toBe(1);
    expect(data.providers.ollama).toBeDefined();
    expect(data.providers.vllm).toEqual({
      name: "vLLM",
      baseUrl: "http://localhost:8000/v1",
      api: "openai-completions",
      apiKey: "none",
      models: [{ id: "qwen", contextWindow: 32768 }, { id: "llama" }],
    });
    removeEndpoint(file, "vllm");
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).providers)).toEqual(["ollama"]);
    expect(() => addEndpoint(file, { name: "x", baseUrl: "h", models: [] })).toThrow();
  });

  it("probes /models, reads vLLM context length and llama.cpp header", async () => {
    let asked = "";
    let auth = "";
    const fake = (async (url: string, init?: RequestInit) => {
      asked = url;
      auth = (init?.headers as Record<string, string>).Authorization ?? "";
      return new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-8B", max_model_len: 40960 }, { id: "b" }] }), {
        headers: { server: "llama.cpp" },
      });
    }) as typeof fetch;
    const p = await probeEndpoint("localhost:8000", "sk-1", fake);
    expect(asked).toBe("http://localhost:8000/v1/models");
    expect(auth).toBe("Bearer sk-1");
    expect(p).toEqual({ baseUrl: "http://localhost:8000/v1", models: ["Qwen/Qwen3-8B", "b"], contextWindows: { "Qwen/Qwen3-8B": 40960 }, llama: true });
    const denied = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(probeEndpoint("h", "bad", denied)).rejects.toThrow(/401/);
  });
});

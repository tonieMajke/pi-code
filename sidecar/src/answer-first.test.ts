import { describe, expect, it } from "vitest";
import { ANSWER_NOTE, AnswerFirst } from "./answer-first";

const tools = [{ type: "function", function: { name: "bash", parameters: {} } }];
const payload = (last: unknown, t: unknown[] = tools) => ({
  model: "m",
  messages: [{ role: "system", content: "s" }, { role: "assistant", content: "x" }, last],
  tools: t,
});

describe("AnswerFirst", () => {
  it("a normal prompt changes nothing", () => {
    const a = new AnswerFirst();
    a.userMessage("zrób X", false);
    expect(a.apply(payload({ role: "user", content: "zrób X" }))).toBeUndefined();
  });

  it("after an interruption the next reply is text only, once", () => {
    const a = new AnswerFirst();
    a.interrupt();
    a.userMessage("Co Ty właściwie teraz robisz, powiedz mi?", false);
    a.startRun();
    const out = a.apply(payload({ role: "user", content: "Co Ty właściwie teraz robisz, powiedz mi?" }))!;
    expect(out.tool_choice).toBe("none");
    expect(out.tools).toEqual(tools); // kept: same prompt prefix, cache survives
    const last = out.messages!.at(-1) as { content: string };
    expect(last.content.endsWith(ANSWER_NOTE)).toBe(true);
    expect(a.answered).toBe(true);
    // the next request of the same run (should there be one) is left alone
    expect(a.apply(payload({ role: "user", content: "Co Ty właściwie teraz robisz, powiedz mi?" }))).toBeUndefined();
    // a new run starts clean
    a.startRun();
    expect(a.answered).toBe(false);
  });

  it("a mid-run message waits for its own request, not a guard's nudge before it", () => {
    const a = new AnswerFirst();
    a.userMessage("co tam?", true);
    expect(a.apply(payload({ role: "user", content: "[Constitution: verification required] ..." }))).toBeUndefined();
    expect(a.apply(payload({ role: "tool", content: "ok" }))).toBeUndefined();
    const out = a.apply(payload({ role: "user", content: [{ type: "text", text: "co tam?\n\n[pi-gui: ...]" }] }))!;
    expect(out.tool_choice).toBe("none");
    expect((out.messages!.at(-1) as { content: unknown[] }).content).toHaveLength(2);
  });

  it("an interruption is consumed by one message; a later normal one is not forced", () => {
    const a = new AnswerFirst();
    a.interrupt();
    a.userMessage("stop", false);
    a.userMessage("dalej", false);
    expect(a.apply(payload({ role: "user", content: "dalej" }))).toBeUndefined();
  });

  it("Anthropic-style tools get an object tool_choice; no tools, no tool_choice", () => {
    const a = new AnswerFirst();
    a.userMessage("hej", true);
    expect(a.apply(payload({ role: "user", content: "hej" }, [{ name: "bash", input_schema: {} }]))!.tool_choice).toEqual({ type: "none" });
    a.userMessage("hej", true);
    expect(a.apply(payload({ role: "user", content: "hej" }, []))!.tool_choice).toBeUndefined();
  });
});

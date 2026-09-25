import { describe, expect, it } from "vitest";
import type { Part } from "../lib/reducer";
import { hiddenReply } from "./Transcript";

const think = (text: string): Part => ({ type: "thinking", text });
const tool: Part = { type: "tool", tool: { id: "t", name: "mcp", args: {}, status: "done", summary: "" } as never };

describe("hiddenReply", () => {
  it("opens reasoning that answers the user and runs straight into a tool call", () => {
    expect(hiddenReply([think("The user is asking me to stop and give a status update. Status: ..."), tool], 0)).toBe(true);
    expect(hiddenReply([think("Użytkownik pyta, co robię."), think("..."), tool], 0)).toBe(true);
  });
  it("leaves ordinary reasoning collapsed", () => {
    expect(hiddenReply([think("Let me list the tabs."), tool], 0)).toBe(false);
    // the model did answer in text
    expect(hiddenReply([think("The user is asking what I do."), { type: "text", text: "Robię X." }, tool], 0)).toBe(false);
    // later in the turn, not the reply to the message
    expect(hiddenReply([tool, think("The user is asking…"), tool], 1)).toBe(false);
  });
});

/**
 * Long silent chains: a model makes 20–90 tool calls without a word while the user asks
 * "co tam?". The guardian extension used to *ask* for a status with a steer message posing
 * as the user — the model ignored it, and every such message moved the context boundary.
 * This is enforced instead: after `toolCalls` calls or `minutes` without visible text, the
 * next tool call is blocked with a request for a status; if the model calls a tool again
 * without writing anything, the run is stopped.
 */
export type TurnLimitConfig = { enabled: boolean; toolCalls: number; minutes: number };

export type TurnLimitVerdict = { kind: "status"; reason: string; label: string } | { kind: "stop"; label: string } | null;

export class TurnLimit {
  private calls = 0;
  private since = 0;
  private asked = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** A new prompt, or the model wrote something the user can read. */
  reset(): void {
    this.calls = 0;
    this.since = this.now();
    this.asked = false;
  }

  beforeTool(c: TurnLimitConfig): TurnLimitVerdict {
    if (!c.enabled) return null;
    this.calls++;
    const minutes = (this.now() - this.since) / 60_000;
    if (this.calls <= c.toolCalls && minutes < c.minutes) return null;
    const what = `${this.calls - 1} wywołań narzędzi / ${Math.floor(minutes)} min bez słowa`;
    if (this.asked) return { kind: "stop", label: `Pi Code zatrzymał turę: ${what}, prośba o status zignorowana` };
    this.asked = true;
    return {
      kind: "status",
      label: `Limit tury: ${what} — model ma podać status`,
      reason:
        `Pi Code: ${this.calls - 1} tool calls and ${Math.floor(minutes)} min without a word to the user. ` +
        "This call did not run. First write the user a short status in visible text (1–3 sentences: what is done, what you are doing, what is next). " +
        "After that you may continue. Calling another tool without writing the status stops the run.",
    };
  }
}

/**
 * Long silent chains: a model makes 20–90 tool calls without a word while the user asks
 * "co tam?". The guardian extension used to *ask* for a status with a steer message posing
 * as the user — the model ignored it, and every such message moved the context boundary.
 * This is enforced instead: after `steps` model messages with tool calls, or `minutes`,
 * without visible text, the tool calls are blocked with a request for a status; if the
 * model's next message again has only tool calls, the run is stopped.
 *
 * Steps, not calls: 14 parallel edits right after a status line are one step the user can
 * follow; 14 sequential silent reads are 14.
 */
export type TurnLimitConfig = { enabled: boolean; steps: number; minutes: number };

export type TurnLimitVerdict = { kind: "status"; reason: string; label: string } | { kind: "stop"; label: string } | null;

export class TurnLimit {
  private steps = 0;
  private since = 0;
  /** Assistant messages so far; the status was asked for during message `askedAt`. */
  private messages = 0;
  private askedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A new prompt: count from zero. */
  reset(): void {
    this.steps = 0;
    this.since = this.now();
    this.askedAt = null;
  }

  /** An assistant message ended; its tool calls (if any) run next. */
  messageEnd(hasText: boolean): void {
    this.messages++;
    if (hasText) this.reset();
    this.steps++;
  }

  /** Called for every tool call of the current message. */
  beforeTool(c: TurnLimitConfig): TurnLimitVerdict {
    if (!c.enabled) return null;
    const minutes = (this.now() - this.since) / 60_000;
    if (this.steps <= c.steps && minutes < c.minutes) return null;
    const what = `${this.steps - 1} kroków / ${Math.floor(minutes)} min bez słowa`;
    if (this.askedAt !== null && this.messages > this.askedAt)
      return { kind: "stop", label: `Pi Code zatrzymał turę: ${what}, prośba o status zignorowana` };
    const first = this.askedAt === null;
    this.askedAt = this.messages;
    return {
      kind: "status",
      // one label per request, not one per call of a parallel batch
      label: first ? `Limit tury: ${what} — model ma podać status` : "",
      reason:
        `Pi Code: ${this.steps - 1} steps and ${Math.floor(minutes)} min without a word to the user. ` +
        "This call did not run. First write the user a short status in visible text (1–3 sentences: what is done, what you are doing, what is next). " +
        "After that you may continue. Answering with tool calls only stops the run.",
    };
  }
}

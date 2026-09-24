/**
 * Pairwise taste judge for visual eval tasks: which of two results looks better designed?
 * Scores ("rate 1–10") drift and flatter; "left or right, and why" doesn't.
 *
 *   pnpm eval:taste dev/eval/results/<A>/results.json dev/eval/results/<B>/results.json [--judge provider/id]
 *
 * Sides are shuffled per task so the judge's left/right bias cancels out. The judge
 * defaults to pi's default model; it must accept images.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { closeBrowser } from "../../sidecar/src/browser.js";
import { lookCompare } from "../../sidecar/src/look.js";

type Result = { task: string; shot?: string; audit?: { high: number; medium: number; low: number }; seconds: number };
type Run = { profile: string; results: Result[] };

const JUDGE_PROMPT = (task: string) => `Two designers got the same brief. Their results are side by side: LEFT and RIGHT.

Brief: ${task}

Which one looks more professionally designed? Judge craft only: visual hierarchy, spacing and alignment, typography, colour restraint, contrast and readability, polish of details. Ignore which content is "more complete" unless something asked for is missing.

Answer in this exact format:
WINNER: LEFT | RIGHT | TIE
REASONS:
- <concrete reason>
- <concrete reason>
- <concrete reason>`;

async function main() {
  const [fa, fb] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const judgeArg = process.argv.includes("--judge") ? process.argv[process.argv.indexOf("--judge") + 1] : undefined;
  if (!fa || !fb) throw new Error("usage: pnpm eval:taste <A/results.json> <B/results.json> [--judge provider/id]");
  const A = JSON.parse(readFileSync(fa, "utf8")) as Run;
  const B = JSON.parse(readFileSync(fb, "utf8")) as Run;
  const services = await createAgentSessionServices({ cwd: process.cwd() });
  const sm = services.settingsManager;
  const [provider, id] = judgeArg ? [judgeArg.slice(0, judgeArg.indexOf("/")), judgeArg.slice(judgeArg.indexOf("/") + 1)] : [sm.getDefaultProvider()!, sm.getDefaultModel()!];
  const model = services.modelRuntime.getModel(provider, id);
  if (!model) throw new Error(`judge model not found: ${provider}/${id}`);
  if (!model.input.includes("image")) throw new Error(`judge ${provider}/${id} can't see images`);

  const prompts = new Map<string, string>();
  const tasksDir = join(dirname(new URL(import.meta.url).pathname), "tasks");
  const tmp = mkdtempSync(join(tmpdir(), "pi-gui-taste-judge-"));
  const tally = { [A.profile]: 0, [B.profile]: 0, tie: 0 };
  const lines: string[] = [];
  // Same task, same repetition index: A's n-th run against B's n-th run.
  const pairs: { ra: Result; rb: Result; i: number }[] = [];
  for (const task of new Set(A.results.map((r) => r.task))) {
    const as = A.results.filter((r) => r.task === task && r.shot);
    const bs = B.results.filter((r) => r.task === task && r.shot);
    for (let i = 0; i < Math.min(as.length, bs.length); i++) pairs.push({ ra: as[i], rb: bs[i], i });
  }
  for (const { ra, rb, i } of pairs) {
    if (!prompts.has(ra.task)) prompts.set(ra.task, (JSON.parse(readFileSync(join(tasksDir, ra.task, "task.json"), "utf8")) as { prompt: string }).prompt);
    const aLeft = Math.random() < 0.5;
    const [left, right] = aLeft ? [ra, rb] : [rb, ra];
    const cmp = await lookCompare({ a: left.shot!, b: right.shot!, labels: ["LEFT", "RIGHT"] }, process.cwd(), join(tmp, `${ra.task}-${i}.png`));
    const res = await services.modelRuntime.complete(
      model,
      {
        systemPrompt: "You are a senior product designer judging visual craft. Be decisive and concrete.",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data: cmp.data, mimeType: cmp.mimeType },
              { type: "text", text: JUDGE_PROMPT(prompts.get(ra.task)!) },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { cacheRetention: "none", sessionId: randomUUID() },
    );
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const w = /WINNER:\s*(LEFT|RIGHT|TIE)/i.exec(text)?.[1]?.toUpperCase() ?? "TIE";
    const winner = w === "TIE" ? "tie" : (w === "LEFT") === aLeft ? A.profile : B.profile;
    tally[winner]++;
    const reasons = text.split("REASONS:")[1]?.trim().split("\n").slice(0, 3).join(" ") ?? "";
    lines.push(`${ra.task.padEnd(14)} → ${winner.padEnd(10)} ${reasons.slice(0, 220)}`);
    console.log(lines[lines.length - 1]);
  }
  const audit = (r: Run) => {
    const v = r.results.filter((x) => x.audit);
    const sum = (k: "high" | "medium") => v.reduce((a, x) => a + x.audit![k], 0);
    const secs = v.reduce((a, x) => a + x.seconds, 0);
    return `${r.profile}: audit high ${sum("high")}, medium ${sum("medium")} over ${v.length} pages · ${Math.round(secs / 60)} min`;
  };
  const summary = [
    "",
    `wins: ${A.profile} ${tally[A.profile]} · ${B.profile} ${tally[B.profile]} · tie ${tally.tie}  (judge ${provider}/${id})`,
    audit(A),
    audit(B),
  ].join("\n");
  console.log(summary);
  const out = join(dirname(fa), `taste-vs-${B.profile}.txt`);
  writeFileSync(out, `${lines.join("\n")}\n${summary}\n`);
  console.log(`saved: ${out} · comparison images in ${tmp}`);
  await closeBrowser();
  process.exit(0);
}

void main();

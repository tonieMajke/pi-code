<p align="center"><img src="branding/pi-code-icon.svg" width="96" alt="Pi Code icon"></p>

# Pi Code

A desktop app for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), the coding agent,
built to feel like the Code tab of Claude Desktop, but aimed at **local models**
(llama.cpp / llama-server, vLLM, LM Studio, Ollama, or any OpenAI-compatible server)
as well as hosted providers.

> **Early alpha. Linux only.** It has been used daily on one machine (Arch-based, Wayland, NVIDIA).
> Expect rough edges. Windows and macOS are not supported yet.

https://github.com/user-attachments/assets/a2404892-3134-42e2-bcec-8e2cc3645298

## What it does

- **Live view of the agent:** streaming answers, thinking, and every tool call with its arguments and result.
  Edits show as a real diff. Long finished chains of steps fold into one row.
- **Permission modes:** ask before every action, or let read-only commands through automatically
  (a shell parser checks each command and its arguments). Risky actions always ask.
  "Always in this session" remembers command prefixes such as `pnpm test`.
- **Local-model stats** when llama-server runs on `localhost:8080`: tokens/s, prompt processing progress,
  GPU status, and a per-turn timeline showing where the time went.
- **Sessions and projects:** a sidebar of chats, recent projects on the welcome screen, a files panel
  (click to insert `@path`), and a changes panel with git status.
- **Handoff to a new session**, open the same session in a terminal with `pi`, and context usage at a glance.
- **Dictation** (optional) through any OpenAI-compatible `/audio/transcriptions` endpoint.
- **Add-ons that keep a local model on track** (below), each one a switch in the composer's **+** menu.
- UI in **English** and **Polish** (it follows the system locale).

## Keeping a small model on track

Local models can write real code, but they cut corners: they edit files they have not read, loop on the
same failing call, say "done" without running anything, and go silent for fifty tool calls. Pi Code adds a
layer around pi that catches these habits. Each piece is a switch in the composer's **+** menu
(details in **Settings**), so you can see what it costs on your model and turn it off.

- **Constitution:** standing working rules appended to the system prompt: plan the task, read before
  editing, check the work, report briefly.
- **Guards** (part of the constitution) enforce the rules small models skip instead of only asking:
  - *read before edit:* an edit to a file the model has not read in this run is sent back;
  - *no loops:* the same failing call repeated, a file edited back to a state it already had, or the same
    check failing the same way again gets a note on the tool result, where the model is looking;
  - *no "done" without proof:* files changed with no test, type check, build or run afterwards means the
    model is sent back to verify (prose, data and pictures are exempt);
  - *a plan it has to finish:* the model's todo list is recited near the end of the context so it stays in
    view on long tasks, and it is checked before the model may stop.
- **Review:** after the work, a fresh session sees only the task and the diff, not the author's reasoning,
  so it does not share the same blind spots. Findings go back to the model. Small changes are skipped.
- **Taste** (visual work): reference images first, then the page, SVG or 3D scene is rendered and measured
  (`ui_audit`: text contrast, spacing, alignment, overflow and clipped text at phone width, too many font sizes), because a small model's vision
  cannot tell 13 px from 16 px. The **critic** is a separate fresh look at the screenshot before the answer.
- **Turn limit:** after a few silent steps or minutes, the model has to write a status line. If it goes
  silent again, the run stops.
- **Memory:** short facts about you, kept in a hand-editable markdown file, carried into every session,
  learned after a session ends.
- **pi-lens and the pi guardian** (if installed): LSP diagnostics and lint after every edit, and a limit
  on what the model may read from `~/.pi/agent/extensions`.

Always on, no switch:

- **Edit repair:** an edit that failed only on indentation is fixed in place. Any other miss comes back
  with the closest real text and its line numbers, so the next try lands.
- **Escalation:** when a model is stuck, one click hands the task to a bigger model you pick, optionally
  undoing the stuck run first.
- **Checkpoints:** every run snapshots the worktree (a hidden git ref, your index and stash untouched), so
  one click undoes everything the run did to files.
- **Answer first:** if you interrupt or write while the model works, its next reply must be text, not
  more tool calls.
- **Cache-friendly context:** old big tool outputs are trimmed only before the current run, so the prompt
  prefix stays stable and llama.cpp's prefix cache keeps working. Handoff writes a prompt for a fresh
  session instead of a lossy compaction.

## Screenshots

| | |
|---|---|
| ![Welcome screen with recent projects](docs/screenshots/welcome.png) | ![A stuck model, handed to a bigger one](docs/screenshots/escalation.png) |
| Welcome screen: sessions, recent projects, your model | A model going in circles is told to change approach, then handed to a bigger one |
| ![A task: diff and a forced test run](docs/screenshots/task.png) | ![The agent renders its page and checks it](docs/screenshots/visual-check.png) |
| Every step on screen; no "done" without a check | Pages and SVGs are rendered and looked at before the answer |

<sub>Screenshots come from a staged session (a scripted sidecar), rendered by the real UI.</sub>

## Requirements

- Linux x86_64 with WebKitGTK (standard on most desktops). The AppImage is built on Ubuntu 22.04,
  so it needs glibc 2.35 or newer.
- **Node.js: nothing to install for the AppImage from Releases**, it carries its own Node for the
  pi process. Pi Code looks for Node in this order: `$PI_CODE_NODE` (when set, the only one tried),
  the bundled one, then `node` on `PATH`. Each must be **22.19 or newer**. If none works, the window
  says which binaries it tried and what to change, instead of closing.
- A model: a server on your machine (llama.cpp, vLLM, LM Studio, Ollama) or a hosted provider.
  See [Connect a model](#connect-a-model).
- Optional: the `pi` CLI (for "open in terminal" and sign-ins that need a browser),
  `nvidia-smi` (GPU status), `pw-record` / `parecord` / `arecord` (dictation),
  ImageMagick 7 (`magick`), `rsvg-convert` and Graphviz (`dot`) for the agent's `look` tool
  (previews of images, SVG, diagrams and pages)

## Install

Download `Pi Code_x.y.z_amd64.AppImage` from [Releases](../../releases), then:

```bash
chmod +x "Pi Code_"*.AppImage
./"Pi Code_"*.AppImage
```

To run the pi process on a Node of your choice:

```bash
PI_CODE_NODE=/opt/node-22/bin/node ./"Pi Code_"*.AppImage
```

## Connect a model

The first start opens a short wizard; it can be skipped and done later in
**Settings → Model providers**. Until a model is picked, the message box says so and Enter
opens that page.

- **A server on your machine** (llama.cpp's `llama-server`, vLLM, LM Studio, Ollama, or anything
  OpenAI-compatible): **Own server** → a name and the URL, e.g. `http://localhost:8080/v1`
  (Ollama: `http://localhost:11434/v1`) → **Test connection** → tick the models → **Add server**.
  It is written to `~/.pi/agent/models.json`, the same file the `pi` CLI uses.
  With llama-server on `localhost:8080` Pi Code also shows speed, prompt progress and GPU state.
- **A hosted provider with an API key** (OpenRouter, Anthropic, OpenAI…): **API key**, pick the
  provider, paste the key. It goes to `~/.pi/agent/auth.json`.
- **Account sign-ins** (Claude Pro/Max, ChatGPT, GitHub Copilot) need a browser: run `pi` in a
  terminal and type `/login`. Pi Code picks them up the next time the list opens.

## Build from source

You need Node 22.19+, pnpm, and a Rust toolchain with the
[Tauri 2 prerequisites for Linux](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm test          # unit, component and e2e tests (the e2e test talks to your default model)
pnpm dev           # browser dev mode: vite + a WebSocket bridge to the sidecar
pnpm desktop       # debug build of the desktop window
pnpm appimage      # release AppImage → src-tauri/target/release/bundle/appimage/
```

`pnpm appimage` does not bundle Node: the result runs the pi process on the system `node`. The
release build adds one:

```bash
dev/fetch-node.sh  # official Node 22 build, checksum-verified, into vendor/node/
pnpm sidecar-rt
NO_STRIP=1 pnpm exec tauri build --config src-tauri/tauri.node.conf.json
```

`NO_STRIP=1` matters: stripping breaks the bundled WebKit and the AppImage stops with
"The WebKit binary … is missing".

### Releases

Pushing a tag `v*` that matches the version in `src-tauri/tauri.conf.json` runs
`.github/workflows/release.yml`: tests (without e2e), the AppImage on Ubuntu 22.04 with Node bundled,
and a **draft pre-release** with the AppImage attached. Publishing is done by hand on GitHub.

### How it is put together

```text
src/          React UI
src-tauri/    Rust: window, spawns the sidecar, pipes its events to the UI
sidecar/      Node + pi SDK: sessions, tools, permissions, stats (JSON lines over stdio)
shared/       protocol types, shell parser, i18n shared by both sides
```

## License

[GPL-3.0-or-later](LICENSE). You may use, share and modify Pi Code freely. If you distribute it,
modified or not, you must share the source under the same license.

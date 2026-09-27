<p align="center"><img src="branding/pi-code-icon.svg" width="96" alt="Pi Code icon"></p>

# Pi Code

A desktop app for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), the coding agent,
built to feel like the Code tab of Claude Desktop, but aimed at **local models**
(llama.cpp / llama-server, vLLM, LM Studio, Ollama, or any OpenAI-compatible server)
as well as hosted providers.

> **Early alpha. Linux only.** It has been used daily on one machine (Arch-based, Wayland, NVIDIA).
> Expect rough edges. Windows and macOS are not supported yet.

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
- **Add-ons** you can toggle: a working constitution, guards, review, and memory.
- UI in **English** and **Polish** (it follows the system locale).

## Requirements

- Linux x86_64 with WebKitGTK (standard on most desktops)
- **Node.js 22 or newer on `PATH`**. The AppImage does not bundle Node.
  Point `PI_CODE_NODE` at another binary if needed.
- A model set up for pi (`~/.pi/agent/`). Run `pi` once in a terminal and use `/login`,
  or add an OpenAI-compatible server in Pi Code's settings.
- Optional: the `pi` CLI (for "open in terminal"), `nvidia-smi` (GPU status),
  `pw-record` / `parecord` / `arecord` (dictation)

## Install

Download `Pi Code_x.y.z_amd64.AppImage` from [Releases](../../releases), then:

```bash
chmod +x "Pi Code_"*.AppImage
./"Pi Code_"*.AppImage
```

## Build from source

You need Node 22+, pnpm, and a Rust toolchain with the
[Tauri 2 prerequisites for Linux](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm test          # unit, component and e2e tests
pnpm dev           # browser dev mode: vite + a WebSocket bridge to the sidecar
pnpm desktop       # debug build of the desktop window
pnpm appimage      # release AppImage → src-tauri/target/release/bundle/appimage/
```

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

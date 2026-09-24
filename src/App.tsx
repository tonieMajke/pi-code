import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { WindowControls } from "./components/WindowControls";
import { WindowFrame } from "./components/WindowFrame";
import { Logo } from "./components/Logo";
import { ArrowDown, FileDiff, ImagePlus, PanelLeftOpen, X } from "lucide-react";
import { initialState, reducer, type InfoLevel, type LivePerf } from "./lib/reducer";
import { createWsTransport, type PiTransport } from "./lib/transport";
import { createTauriTransport, inTauri } from "./lib/tauri";
import { formatDuration, formatTokens, sessionTitle } from "./lib/format";
import { applyAppearance, cachedAppearance, downscaleImage } from "./lib/appearance";
import type {
  Appearance,
  AppearancePatch,
  Attachment,
  ForkPoint,
  GitChanges,
  HistoryItem,
  ModelSummary,
  PiSettings,
  RouterStatus,
  SessionStats,
  SessionSummary,
  SlashCommandInfo,
  UiAnswer,
} from "../shared/protocol";
import { allCommands, parseSlash, type PickItem, type SlashPick } from "./lib/slash";
import { copyText } from "./lib/code-block";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { Toasts, type Toast } from "./components/Toasts";
import { ChangesPanel } from "./components/ChangesPanel";
import { GpuStatus } from "./components/GpuStatus";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { MODES } from "./lib/modes";
import { ApprovalCard } from "./components/Approval";
import { fileToAttachment, imageFiles } from "./lib/images";
import { modeInfo, nextMode } from "./lib/modes";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { SettingsDialog, type AppPrefs } from "./components/Settings";

const SIDEBAR_KEY = "pi-gui.sidebar";
const PREFS_KEY = "pi-gui.prefs";

function readPrefs(): AppPrefs {
  try {
    return { notifications: true, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<AppPrefs>) };
  } catch {
    return { notifications: true };
  }
}

function readSidebarPref(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [router, setRouter] = useState<RouterStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [prefs, setPrefs] = useState(readPrefs);
  const [appearance, setAppearance] = useState<Appearance>(cachedAppearance);
  const [imageBusy, setImageBusy] = useState(false);
  const [piCommands, setPiCommands] = useState<SlashCommandInfo[]>([]);
  const [forkPoints, setForkPoints] = useState<ForkPoint[] | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** An extension command is running: its ctx.ui.notify output belongs in the transcript. */
  const commandOutputRef = useRef(false);
  /** Transcript items to re-add once the next history reload lands (it replaces the view). */
  const afterHistoryRef = useRef<({ role: "command"; text: string } | { role: "info"; text: string; level: InfoLevel })[]>([]);
  const appearancePatchRef = useRef<AppearancePatch>({});
  const appearanceTimerRef = useRef<number | undefined>(undefined);
  const restoringRef = useRef<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPref);
  const [atBottom, setAtBottom] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const transportRef = useRef<PiTransport | null>(null);

  const send = useCallback((cmd: Parameters<PiTransport["send"]>[0]) => transportRef.current?.send(cmd), []);

  const toast = useCallback((text: string, level: InfoLevel = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, level }]);
    // Errors stay until closed; the rest fades out.
    if (level !== "error") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // A run may have created/renamed a session — refresh the sidebar after every settled.
  useEffect(() => {
    if (state.settledCount > 0) send({ cmd: "sessions_list" });
  }, [state.settledCount, send]);

  useEffect(() => {
    // In the Tauri shell the sidecar is spawned by Rust (stdio); in the
    // browser we go through the local WS dev bridge.
    const t: PiTransport = inTauri() ? createTauriTransport() : createWsTransport("ws://127.0.0.1:9877");
    transportRef.current = t;
    const off = t.onMessage((msg) => {
      if ("event" in msg) {
        const e = msg.event;
        switch (e.kind) {
          case "notice":
            if (commandOutputRef.current) dispatch({ type: "info", text: e.text, level: e.level });
            else toast(e.text, e.level);
            return;
          case "editor_text":
            setInput(e.text);
            requestAnimationFrame(() => inputRef.current?.focus());
            return;
          case "session_changed":
            dispatch({ type: "clear" });
            t.send({ cmd: "history" });
            t.send({ cmd: "sessions_list" });
            return;
          case "init_done":
            // Extensions, templates and skills are per project — refresh "/" on every (re)init.
            t.send({ cmd: "commands_list" });
            break;
          case "settled":
            commandOutputRef.current = false;
            break;
        }
        dispatch({ type: "event", event: e, at: Date.now() });
        return;
      }
      if (!msg.ok) {
        if (msg.cmd === "compact") {
          setCompacting(false);
          afterHistoryRef.current = [];
        }
        if (msg.cmd === "fork_points") setForkPoints([]);
        if (msg.cmd === "appearance_image") setImageBusy(false);
        dispatch({ type: "error", error: `${msg.cmd ?? "pi"}: ${msg.error}` });
        return;
      }
      switch (msg.cmd) {
        case "sessions_list":
          dispatch({ type: "sessions", sessions: msg.result as SessionSummary[], loading: false });
          return;
        case "history":
          dispatch({ type: "history", items: msg.result as HistoryItem[] });
          for (const m of afterHistoryRef.current) {
            dispatch(m.role === "command" ? { type: "command", text: m.text } : { type: "info", text: m.text, level: m.level });
          }
          afterHistoryRef.current = [];
          return;
        case "commands_list":
          setPiCommands(msg.result as SlashCommandInfo[]);
          return;
        case "reload":
          setPiCommands(msg.result as SlashCommandInfo[]);
          dispatch({ type: "info", text: "Przeładowano rozszerzenia, skille, szablony i pliki kontekstu." });
          return;
        case "fork_points":
          setForkPoints(msg.result as ForkPoint[]);
          return;
        case "session_fork":
          setInput((msg.result as { text: string }).text);
          afterHistoryRef.current = [{ role: "info", text: "Nowa sesja od wybranej wiadomości — wiadomość czeka w polu do poprawienia.", level: "info" }];
          t.send({ cmd: "history" });
          t.send({ cmd: "sessions_list" });
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        case "session_clone":
          afterHistoryRef.current = [{ role: "info", text: "To jest kopia sesji — oryginał został bez zmian.", level: "info" }];
          t.send({ cmd: "history" });
          t.send({ cmd: "sessions_list" });
          return;
        case "session_stats":
          dispatch({ type: "info", text: formatStats(msg.result as SessionStats) });
          return;
        case "export_html":
          dispatch({ type: "info", text: `Zapisano sesję jako HTML:\n\n\`${(msg.result as { path: string }).path}\`` });
          return;
        case "models_list":
          dispatch({ type: "models", models: msg.result as ModelSummary[] });
          return;
        case "session_rename":
          t.send({ cmd: "sessions_list" });
          return;
        case "git_changes":
        case "git_revert":
          setChanges(msg.result as GitChanges);
          setChangesLoading(false);
          return;
        case "files_list":
          setFiles(msg.result as string[]);
          return;
        case "router_status":
          setRouter(msg.result as RouterStatus);
          return;
        case "settings_get":
        case "settings_set":
          setSettings(msg.result as PiSettings);
          return;
        // appearance_set replies are ignored: the UI state is applied optimistically
        // and an older reply must not snap a slider back while it is being dragged.
        case "appearance_get":
          setAppearance(msg.result as Appearance);
          return;
        case "appearance_image":
          setAppearance((a) => ({ ...a, imageUrl: (msg.result as Appearance).imageUrl }));
          setImageBusy(false);
          return;
        case "checkpoint_restore":
          if (restoringRef.current) dispatch({ type: "restored", checkpoint: restoringRef.current });
          restoringRef.current = null;
          t.send({ cmd: "git_changes" });
          return;
        case "compact":
          setSettings(msg.result as PiSettings);
          setCompacting(false);
          if (afterHistoryRef.current.length) afterHistoryRef.current.push({ role: "info", text: "Kontekst skompaktowany.", level: "info" });
          t.send({ cmd: "history" });
          return;
        case "rewind":
          setInput((msg.result as { text: string }).text);
          t.send({ cmd: "history" });
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
      }
    });
    const offOpen = t.onOpen(() => {
      // Boot (or re-boot after bridge restart): init is idempotent in the sidecar.
      t.send({ cmd: "appearance_get" });
      t.send({ cmd: "init" });
      t.send({ cmd: "commands_list" });
      t.send({ cmd: "history" });
      t.send({ cmd: "sessions_list" });
      t.send({ cmd: "models_list" });
    });
    return () => {
      off();
      offOpen();
      t.close();
      transportRef.current = null;
    };
  }, []);

  useEffect(() => applyAppearance(appearance), [appearance]);

  const patchAppearance = useCallback(
    (patch: AppearancePatch) => {
      setAppearance((a) => ({ ...a, ...patch, image: { ...a.image, ...patch.image } }));
      // Sliders fire per pixel: batch the patches and save once they settle.
      const pending = appearancePatchRef.current;
      appearancePatchRef.current = { ...pending, ...patch, image: { ...pending.image, ...patch.image } };
      window.clearTimeout(appearanceTimerRef.current);
      appearanceTimerRef.current = window.setTimeout(() => {
        send({ cmd: "appearance_set", patch: appearancePatchRef.current });
        appearancePatchRef.current = {};
      }, 250);
    },
    [send],
  );

  const setBackgroundImage = useCallback(
    (file: File | null) => {
      if (!file) {
        send({ cmd: "appearance_image", dataUrl: null });
        return;
      }
      setImageBusy(true);
      downscaleImage(file)
        .then((dataUrl) => send({ cmd: "appearance_image", dataUrl }))
        .catch((err) => {
          setImageBusy(false);
          dispatch({ type: "error", error: `obraz tła: ${err instanceof Error ? err.message : String(err)}` });
        });
    },
    [send],
  );

  // Changes panel: refresh when opened, after every run, and when a mutating tool finishes.
  const toolEnds = state.messages.reduce(
    (n, m) => n + (m.role === "assistant" ? m.parts.filter((p) => p.type === "tool" && p.tool.status !== "running").length : 0),
    0,
  );
  const refreshChanges = useCallback(() => {
    setChangesLoading(true);
    send({ cmd: "git_changes" });
  }, [send]);
  useEffect(() => {
    if (changesOpen) refreshChanges();
  }, [changesOpen, toolEnds, state.settledCount, state.cwd, refreshChanges]);

  // @-mention file list belongs to the session's project.
  useEffect(() => setFiles(null), [state.cwd]);

  // GPU / router status: cheap (nvidia-smi + GET /v1/models), poll every 5 s.
  useEffect(() => {
    if (!state.connected) return;
    send({ cmd: "router_status" });
    const id = setInterval(() => send({ cmd: "router_status" }), 5000);
    return () => clearInterval(id);
  }, [state.connected, send]);

  // Desktop notification when a run ends or pi waits for approval while the window is in the background.
  const lastSettled = useRef(0);
  useEffect(() => {
    if (state.settledCount === lastSettled.current) return;
    lastSettled.current = state.settledCount;
    if (document.hasFocus() || !prefsRef.current.notifications) return;
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    const text =
      last?.role === "assistant"
        ? last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ")
        : "";
    send({ cmd: "notify", title: "pi skończył", body: text.replace(/\s+/g, " ").slice(0, 140) || "Gotowe." });
  }, [state.settledCount, state.messages, send]);
  const approvalCount = state.approvals.length;
  useEffect(() => {
    if (approvalCount > 0 && !document.hasFocus() && prefsRef.current.notifications) {
      send({ cmd: "notify", title: "pi czeka na zgodę", body: `${state.approvals[0].toolName}: ${JSON.stringify(state.approvals[0].args).slice(0, 120)}` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify once per new request
  }, [approvalCount]);

  // Live clock for durations — only ticks while the model works.
  useEffect(() => {
    if (!state.busy) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state.busy]);

  // Autoscroll only while the user is pinned to the bottom (don't fight their scroll).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  };
  // Follow content growth from any source (deltas, async shiki, expanding cards)
  // while pinned to the bottom — a messages-only effect misses async layout.
  const empty = state.messages.length === 0;
  useEffect(() => {
    const el = scrollRef.current;
    const col = columnRef.current;
    if (!el || !col) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    ro.observe(el); // composer growth shrinks the viewport
    return () => ro.disconnect();
  }, [empty]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const submit = () => {
    const text = input.trim();
    const images = attachments.length ? attachments : undefined;
    if ((!text && !images) || !state.connected) return;
    const slash = images ? null : parseSlash(text);
    if (slash) {
      runSlash(slash.name, slash.args);
      return;
    }
    setInput("");
    setAttachments([]);
    atBottomRef.current = true;
    setAtBottom(true);
    dispatch({ type: "user", text, images, at: Date.now() });
    send({ cmd: "prompt", text, images, behavior: state.busy ? "steer" : undefined });
  };

  const addFiles = useCallback(async (files: File[]) => {
    for (const f of files) {
      try {
        const a = await fileToAttachment(f);
        setAttachments((cur) => [...cur, a]);
      } catch (err) {
        dispatch({ type: "error", error: `obraz: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }, []);

  const setMode = useCallback(
    (mode: typeof state.mode) => {
      // Optimistic: rapid Shift+Tab presses must cycle from the new mode, not the stale one.
      dispatch({ type: "event", event: { kind: "mode", mode } });
      send({ cmd: "mode_set", mode });
    },
    [send],
  );

  const executePlan = () => {
    setMode("acceptEdits");
    const text = "Wykonaj ten plan.";
    dispatch({ type: "user", text, at: Date.now() });
    send({ cmd: "prompt", text });
  };

  const stop = useCallback(() => send({ cmd: "abort" }), [send]);

  const resetView = () => {
    dispatch({ type: "clear" });
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const newSession = useCallback(
    (cwd?: string) => {
      resetView();
      send({ cmd: "session_new", cwd });
      send({ cmd: "sessions_list" });
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [send],
  );

  const openSession = (path: string) => {
    resetView();
    send({ cmd: "session_open", path });
    send({ cmd: "history" });
  };

  // Settings are per session in part (thinking level, tools) — refetch on open and on session swap.
  useEffect(() => {
    if (settingsOpen && state.connected) send({ cmd: "settings_get" });
  }, [settingsOpen, state.connected, state.sessionPath, state.model, send]);

  const savePrefs = (p: AppPrefs) => {
    setPrefs(p);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable — preference lasts until reload */
    }
  };

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, o ? "closed" : "open");
      } catch {
        /* storage unavailable — preference just won't persist */
      }
      return !o;
    });
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newSession();
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!sidebarOpen) toggleSidebar();
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setChangesOpen((o) => !o);
      } else if (e.key === "Tab" && e.shiftKey && !mod) {
        e.preventDefault();
        setMode(nextMode(state.mode));
      } else if (e.key === "Escape" && state.busy && !e.defaultPrevented) {
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, toggleSidebar, stop, setMode, state.busy, state.mode, sidebarOpen]);

  const approval = state.approvals[0];
  const awaiting = new Set(state.approvals.map((a) => a.toolCallId));
  const decide = (decision: "allow" | "always" | "deny", reason?: string) => {
    if (!approval) return;
    if (reason) setInput("");
    send({ cmd: "approve", toolCallId: approval.toolCallId, decision, reason });
  };
  const editMessage = (fromEnd: number) => send({ cmd: "rewind", fromEnd });

  const slashCommands = allCommands(piCommands);

  /** Run "/name args". Clears the composer unless the user has to fix what they typed. */
  const runSlash = (name: string, args: string) => {
    const entry = slashCommands.find((c) => c.name === name);
    const done = () => setInput("");
    const echo = (text = `/${name}${args ? ` ${args}` : ""}`) => dispatch({ type: "command", text });
    const info = (text: string, level: InfoLevel = "info") => dispatch({ type: "info", text, level });
    if (!entry) {
      info(`Nie ma komendy \`/${name}\`. Wpisz \`/\`, żeby zobaczyć listę.`, "warning");
      return;
    }
    if (entry.kind !== "gui" && entry.kind !== "terminal" && state.busy) {
      toast("Model pracuje — komendy pi uruchomisz, gdy skończy (Esc przerywa).", "warning");
      return;
    }
    done();
    switch (entry.kind) {
      case "terminal":
        echo();
        info(`\`/${name}\` działa tylko w pi w terminalu. Otwieranie sesji w terminalu będzie w następnym kroku.`, "warning");
        return;
      case "extension":
        // pi runs it inside prompt(); its ctx.ui.notify output lands under this line.
        commandOutputRef.current = true;
        dispatch({ type: "command", text: `/${name}${args ? ` ${args}` : ""}`, run: true, at: Date.now() });
        send({ cmd: "prompt", text: `/${name}${args ? ` ${args}` : ""}` });
        return;
      case "prompt":
      case "skill": {
        // pi expands the template / skill into the prompt the model gets.
        const text = `/${name}${args ? ` ${args}` : ""}`;
        dispatch({ type: "user", text, at: Date.now() });
        send({ cmd: "prompt", text });
        return;
      }
    }
    switch (name) {
      case "compact":
        echo();
        afterHistoryRef.current = [{ role: "command", text: `/compact${args ? ` ${args}` : ""}` }];
        setCompacting(true);
        send({ cmd: "compact", instructions: args || undefined });
        return;
      case "new":
        newSession();
        return;
      case "name":
        if (!args) {
          setInput("/name ");
          info("Podaj nazwę: `/name Nowa nazwa`.", "warning");
          return;
        }
        send({ cmd: "session_rename", name: args });
        return;
      case "model": {
        const q = args.toLowerCase();
        const m =
          state.models.find((x) => `${x.provider}/${x.id}` === args) ??
          state.models.find((x) => x.id.toLowerCase() === q) ??
          state.models.find((x) => x.id.toLowerCase().includes(q));
        if (!args || !m) {
          setInput("/model ");
          if (args) info(`Nie znam modelu „${args}”.`, "warning");
          return;
        }
        send({ cmd: "model_set", provider: m.provider, modelId: m.id });
        toast(`Model: ${m.id}`);
        return;
      }
      case "thinking":
        if (!args) {
          setInput("/thinking ");
          return;
        }
        send({ cmd: "settings_set", patch: { thinkingLevel: args } });
        toast(`Myślenie: ${args}`);
        return;
      case "mode": {
        const q = args.toLowerCase();
        const m = MODES.find((x) => x.id.toLowerCase() === q || x.label.toLowerCase() === q) ?? MODES.find((x) => x.label.toLowerCase().includes(q));
        if (!args || !m) {
          setInput("/mode ");
          return;
        }
        setMode(m.id);
        return;
      }
      case "fork":
        if (!args) {
          setInput("/fork ");
          return;
        }
        resetView();
        send({ cmd: "session_fork", entryId: args });
        return;
      case "clone":
        resetView();
        send({ cmd: "session_clone" });
        return;
      case "session":
        echo();
        send({ cmd: "session_stats" });
        return;
      case "export":
        echo();
        send({ cmd: "export_html" });
        return;
      case "copy": {
        const last = [...state.messages].reverse().find((m) => m.role === "assistant");
        const text = last?.role === "assistant" ? last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n\n") : "";
        if (!text.trim()) {
          toast("Nie ma jeszcze odpowiedzi do skopiowania.", "warning");
          return;
        }
        void copyText(text).then(() => toast("Skopiowano ostatnią odpowiedź."));
        return;
      }
      case "reload":
        echo();
        send({ cmd: "reload" });
        return;
      case "settings":
        setSettingsOpen(true);
        return;
    }
  };

  const pickItems = (pick: SlashPick): PickItem[] | null => {
    switch (pick) {
      case "model":
        return state.models.map((m) => ({
          key: `${m.provider}/${m.id}`,
          label: m.id,
          hint: formatTokens(m.contextWindow),
          active: m.id === state.model && m.provider === state.provider,
        }));
      case "thinking":
        if (!settings) return null;
        return settings.thinking.available.map((l) => ({ key: l, label: l, active: l === settings.thinking.level }));
      case "mode":
        return MODES.map((m) => ({ key: m.id, label: m.label, hint: m.desc, active: m.id === state.mode }));
      case "fork":
        return forkPoints?.map((f) => ({ key: f.entryId, label: f.text.replace(/\s+/g, " ").slice(0, 120) || "(pusta wiadomość)" })) ?? null;
    }
  };

  const onNeedPick = (pick: SlashPick) => {
    if (pick === "fork") {
      setForkPoints(null);
      send({ cmd: "fork_points" });
    } else if (pick === "thinking") send({ cmd: "settings_get" });
  };

  const dialog = state.dialogs[0];
  const answerDialog = (answer: UiAnswer) => {
    if (!dialog) return;
    dispatch({ type: "dialog_done", id: dialog.id });
    send({ cmd: "ui_response", requestId: dialog.id, answer });
  };

  const commands: Command[] = [
    { id: "new", group: "Akcje", label: "Nowa sesja", hint: <kbd>Ctrl N</kbd>, run: () => newSession() },
    { id: "changes", group: "Akcje", label: changesOpen ? "Ukryj panel zmian" : "Pokaż panel zmian", hint: <kbd>Ctrl Shift D</kbd>, run: () => setChangesOpen((o) => !o) },
    { id: "sidebar", group: "Akcje", label: sidebarOpen ? "Zwiń panel sesji" : "Pokaż panel sesji", hint: <kbd>Ctrl B</kbd>, run: toggleSidebar },
    { id: "settings", group: "Akcje", label: "Ustawienia", hint: <kbd>Ctrl ,</kbd>, keywords: "settings konfiguracja", run: () => setSettingsOpen(true) },
    { id: "compact", group: "Akcje", label: "Kompaktuj kontekst", keywords: "compact", run: () => { setCompacting(true); send({ cmd: "compact" }); } },
    ...(state.busy ? [{ id: "stop", group: "Akcje", label: "Przerwij model", hint: <kbd>Esc</kbd>, run: stop }] : []),
    ...MODES.map((m) => ({
      id: `mode-${m.id}`,
      group: "Tryb uprawnień",
      label: m.label,
      hint: m.id === state.mode ? "aktywny" : m.desc,
      keywords: "tryb mode",
      run: () => setMode(m.id),
    })),
    ...state.models.map((m) => ({
      id: `model-${m.provider}/${m.id}`,
      group: "Model",
      label: m.id,
      hint: m.id === state.model ? "aktywny" : formatTokens(m.contextWindow),
      keywords: "model",
      run: () => send({ cmd: "model_set", provider: m.provider, modelId: m.id }),
    })),
    ...state.sessions.slice(0, 200).map((s) => ({
      id: `session-${s.path}`,
      group: "Sesje",
      label: sessionTitle(s),
      hint: s.cwd.replace(/^\/home\/[^/]+/, "~"),
      keywords: s.cwd,
      run: () => openSession(s.path),
    })),
  ];

  const lastMsg = state.messages[state.messages.length - 1];
  const planDone =
    state.mode === "plan" && !state.busy && lastMsg?.role === "assistant" && !lastMsg.open &&
    lastMsg.parts.some((p) => p.type === "text");

  const active = state.sessions.find((s) => s.path === state.sessionPath);
  const title = state.sessionName || (active ? sessionTitle(active) : "") || firstUserText(state) || "Nowa sesja";

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSend={submit}
      onStop={stop}
      busy={state.busy}
      connected={state.connected}
      pending={state.pending}
      mode={state.mode}
      onMode={setMode}
      attachments={attachments}
      onAddFiles={(f) => void addFiles(f)}
      onRemoveAttachment={(i) => setAttachments((cur) => cur.filter((_, j) => j !== i))}
      blocked={Boolean(approval)}
      files={files}
      onNeedFiles={() => send({ cmd: "files_list" })}
      model={state.model}
      provider={state.provider}
      models={state.models}
      onModel={(m) => send({ cmd: "model_set", provider: m.provider, modelId: m.id })}
      cwd={state.cwd}
      branch={state.branch}
      sessions={state.sessions}
      onProject={(cwd) => newSession(cwd)}
      usage={state.usage}
      inputRef={inputRef}
      hero={empty}
      commands={slashCommands}
      pickItems={pickItems}
      onNeedPick={onNeedPick}
      onCommand={runSlash}
    />
  );

  return (
    <div
      className={`app ${sidebarOpen ? "" : "side-closed"}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(imageFiles(e.dataTransfer.files));
      }}
    >
      {inTauri() && <WindowFrame />}
      {appearance.imageUrl && (
        <div className="app-bg" aria-hidden>
          <div className="app-bg-img" style={{ backgroundImage: `url("${appearance.imageUrl}")` }} />
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <ImagePlus size={28} />
          <span>Upuść obraz, żeby dołączyć go do wiadomości</span>
        </div>
      )}
      {sidebarOpen && (
        <Sidebar
          sessions={state.sessions}
          loading={state.loadingSessions}
          activePath={state.sessionPath}
          busyPath={state.busy ? state.sessionPath : ""}
          onOpen={openSession}
          onNew={() => newSession()}
          onCollapse={toggleSidebar}
          onSettings={() => setSettingsOpen(true)}
          searchRef={searchRef}
          user={state.user}
        />
      )}

      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          {!sidebarOpen && (
            <button className="icon-btn" onClick={toggleSidebar} title="Pokaż panel (Ctrl+B)">
              <PanelLeftOpen size={16} />
            </button>
          )}
          {!empty && (
            <SessionTitle
              key={state.sessionPath}
              title={title}
              onRename={(name) => send({ cmd: "session_rename", name })}
            />
          )}
          <span className="topbar-spacer" data-tauri-drag-region />
          <GpuStatus status={router} model={state.model} />
          <button
            className={`icon-btn ${changesOpen ? "on" : ""}`}
            onClick={() => setChangesOpen((o) => !o)}
            title="Zmiany w projekcie (Ctrl+Shift+D)"
          >
            <FileDiff size={16} />
            {changes && changes.files.length > 0 && <span className="badge">{changes.files.length}</span>}
          </button>
          {state.mode !== "ask" && (
            <span className={`mode-badge mode-${state.mode}`} title={modeInfo(state.mode).desc}>
              {modeInfo(state.mode).label}
            </span>
          )}
          <span className={`conn ${state.connected ? "on" : ""}`} title={inTauri() ? "transport: tauri" : "transport: ws"}>
            <span className="conn-dot" />
            {state.connected ? "pi" : "łączenie…"}
          </span>
          {inTauri() && <WindowControls />}
        </header>

        {state.error && (
          <div className="error-bar">
            <span>{state.error}</span>
            <button className="icon-btn" onClick={() => dispatch({ type: "error", error: null })} title="Zamknij">
              <X size={14} />
            </button>
          </div>
        )}

        {empty ? (
          <div className="hero">
            <Logo size={60} className="hero-mark" />
            <h1>Co dalej, Majku?</h1>
            {dialog && <ExtensionDialog key={dialog.id} request={dialog} queued={state.dialogs.length - 1} onAnswer={answerDialog} />}
            {composer}
            <div className="hero-hints">
              <kbd>/</kbd> komendy · <kbd>Ctrl N</kbd> nowa sesja · <kbd>Ctrl K</kbd> szukaj · <kbd>Ctrl B</kbd> panel
            </div>
          </div>
        ) : (
          <>
            <div className="scroll" ref={scrollRef} onScroll={onScroll}>
              <div className="column" ref={columnRef}>
                <Transcript
                  messages={state.messages}
                  cwd={state.cwd}
                  now={now}
                  awaiting={awaiting}
                  onEdit={state.busy ? undefined : editMessage}
                  onRestore={
                    state.busy
                      ? undefined
                      : (checkpoint) => {
                          restoringRef.current = checkpoint;
                          send({ cmd: "checkpoint_restore", checkpoint });
                        }
                  }
                  onExecutePlan={planDone ? executePlan : undefined}
                />
                {state.busy && !approval && <Working since={state.busySince} now={now} perf={state.perf} />}
              </div>
            </div>
            <div className="dock">
              {!atBottom && (
                <button className="to-bottom" onClick={scrollToBottom} title="Przewiń na dół">
                  <ArrowDown size={16} />
                </button>
              )}
              {state.stuck && !state.busy && (
                <StuckCard
                  stuck={state.stuck}
                  onEscalate={() => {
                    const model = state.stuck!.suggest;
                    dispatch({ type: "user", text: `↗ Przekaż zadanie modelowi ${model.split("/").pop()} (poprzedni utknął)`, at: Date.now() });
                    send({ cmd: "escalate", model, reason: state.stuck!.label });
                  }}
                  onSettings={() => setSettingsOpen(true)}
                  onDismiss={() => dispatch({ type: "unstuck" })}
                />
              )}
              {dialog && <ExtensionDialog key={dialog.id} request={dialog} queued={state.dialogs.length - 1} onAnswer={answerDialog} />}
              {approval && (
                <ApprovalCard
                  approval={approval}
                  queued={state.approvals.length - 1}
                  cwd={state.cwd}
                  onDecide={decide}
                  reasonDraft={input}
                />
              )}
              {composer}
            </div>
          </>
        )}
      </main>
      {changesOpen && (
        <ChangesPanel
          changes={changes}
          loading={changesLoading}
          onRefresh={refreshChanges}
          onRevert={(path) => {
            setChangesLoading(true);
            send({ cmd: "git_revert", path });
          }}
          onClose={() => setChangesOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          models={state.models}
          model={state.model}
          provider={state.provider}
          busy={state.busy}
          prefs={prefs}
          onPrefs={savePrefs}
          onPatch={(patch) => send({ cmd: "settings_set", patch })}
          onCompact={() => {
            setCompacting(true);
            send({ cmd: "compact" });
          }}
          compacting={compacting}
          appearance={appearance}
          onAppearance={patchAppearance}
          onImage={setBackgroundImage}
          imageBusy={imageBusy}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <Toasts toasts={toasts} onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function StuckCard({
  stuck,
  onEscalate,
  onSettings,
  onDismiss,
}: {
  stuck: { label: string; suggest: string };
  onEscalate: () => void;
  onSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="stuck-card">
      <div className="stuck-text">
        <b>Model utknął.</b> {stuck.label}.{" "}
        {stuck.suggest ? "Możesz przekazać zadanie mocniejszemu modelowi." : "Nie ustawiono modelu do eskalacji."}
      </div>
      <div className="stuck-actions">
        {stuck.suggest ? (
          <button className="btn primary" onClick={onEscalate}>
            Przekaż do {stuck.suggest.split("/").pop()}
          </button>
        ) : (
          <button className="btn" onClick={onSettings}>
            Ustaw model do eskalacji
          </button>
        )}
        <button className="btn" onClick={onDismiss}>
          Zamknij
        </button>
      </div>
    </div>
  );
}

function formatStats(st: SessionStats): string {
  const t = st.tokens;
  const lines = [
    "**Sesja**",
    `- wiadomości: ${st.userMessages} Twoich, ${st.assistantMessages} modelu, ${st.toolCalls} wywołań narzędzi`,
    `- tokeny: ${formatTokens(t.input)} wejście${t.cacheRead ? ` (z cache ${formatTokens(t.cacheRead)})` : ""}, ${formatTokens(t.output)} wyjście, razem ${formatTokens(t.total)}`,
  ];
  if (st.cost > 0) lines.push(`- koszt: $${st.cost.toFixed(4)}`);
  if (st.sessionFile) lines.push(`- plik: \`${st.sessionFile.replace(/^\/home\/[^/]+/, "~")}\``);
  return lines.join("\n");
}

function firstUserText(state: { messages: { role: string; text?: string }[] }): string {
  const m = state.messages.find((x) => x.role === "user");
  return m?.text?.replace(/\s+/g, " ").slice(0, 80) ?? "";
}

function Working({ since, now, perf }: { since: number | null; now: number; perf: LivePerf | null }) {
  let label = "Pracuje…";
  let detail: string | null = null;
  let progress: number | null = null;
  if (perf?.phase === "prompt") {
    const fresh = perf.total - perf.cache;
    const done = perf.processed - perf.cache;
    progress = fresh > 0 ? Math.min(1, done / fresh) : 1;
    label = "Czyta kontekst…";
    detail =
      `${Math.round(progress * 100)}% z ${formatTokens(fresh)} tok` +
      (perf.cache > 0 ? ` (cache ${formatTokens(perf.cache)})` : "") +
      (perf.perSec > 0 ? ` · PP ${Math.round(perf.perSec)} t/s` : "");
  } else if (perf?.phase === "gen") {
    label = "Generuje…";
    detail = `${perf.perSec.toFixed(1).replace(".", ",")} t/s · ${perf.tokens} tok`;
  }
  return (
    <div className="working">
      <span className="working-star">✻</span>
      <span className="shimmer">{label}</span>
      {since !== null && <span className="working-time">{formatDuration(now - since)}</span>}
      {detail && <span className="working-perf">{detail}</span>}
      {progress !== null && (
        <span className="working-bar">
          <span style={{ width: `${progress * 100}%` }} />
        </span>
      )}
      <span className="working-hint">
        <kbd>Esc</kbd> przerwij
      </span>
    </div>
  );
}

function SessionTitle({ title, onRename }: { title: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (!editing) {
    return (
      <button
        className="session-title"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        title="Kliknij, aby zmienić nazwę"
      >
        {title}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== title) onRename(name);
  };
  return (
    <input
      className="session-title-input"
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
    />
  );
}

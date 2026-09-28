import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { addProject, moveToGroup } from "./lib/sidebar";
import { imageStore } from "./lib/image-store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { FindBar } from "./components/FindBar";
import { StatsDialog } from "./components/StatsDialog";
import { RecentProjects } from "./components/RecentProjects";
import { FilesPanel } from "./components/FilesPanel";
import { LimitDialog } from "./components/LimitDialog";
import { clearFind, findMatches, hitsOf, paintFind } from "./lib/find";
import { WindowControls } from "./components/WindowControls";
import { WindowFrame } from "./components/WindowFrame";
import { Logo } from "./components/Logo";
import { ArrowDown, FileDiff, FolderOpen, FolderTree, ImagePlus, PanelLeftOpen, SquareTerminal, X } from "lucide-react";
import { Welcome } from "./components/Welcome";
import type { BackgroundBlock, ClientCommandInput, OnboardingState, SessionStatus } from "../shared/protocol";
import { initialState, reducer, type InfoLevel, type LivePerf } from "./lib/reducer";
import { pushVoiceLevel } from "./lib/voice-meter";
import { createWsTransport, downReason, type PiRequest, type PiTransport } from "./lib/transport";
import { lang, plural, t } from "../shared/i18n";
import { invoke } from "@tauri-apps/api/core";
import { createTauriTransport, inTauri, readStartupProblem, type StartupProblem } from "./lib/tauri";
import { basename, formatDuration, formatTokens, sessionTitle } from "./lib/format";
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
  SidebarState,
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
import { modes } from "./lib/modes";
import { ApprovalCard } from "./components/Approval";
import { fileToAttachment, imageFiles } from "./lib/images";
import { clipboardImage, isImagePath, pickImages, readImagePaths } from "./lib/native-images";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { modeInfo, nextMode } from "./lib/modes";
import { isNoModelFailure, noModelHint, noModelInfo } from "./lib/no-model";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { TerminalBar } from "./components/TerminalBar";
import { StartupBanner } from "./components/StartupBanner";
import { SettingsDialog, type AppPrefs, type SectionId } from "./components/Settings";
import { TerminalOpenDialog } from "./components/TerminalOpenDialog";
import { isTerminalWarnHidden, markTerminalWarnHidden } from "./lib/terminal-warn";
import { saveLang } from "./lib/lang";
import type { Lang } from "../shared/i18n";

const SIDEBAR_KEY = "pi-gui.sidebar";
const PREFS_KEY = "pi-gui.prefs";
const DEFAULT_PREFS: AppPrefs = { notifications: true, closeToTray: true };

function readPrefs(): AppPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<AppPrefs>) };
  } catch {
    return DEFAULT_PREFS;
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
  const [changesOpen, setChangesOpenRaw] = useState(false);
  /** Files panel (project tree); it shares the right-hand side with the changes panel. */
  const [filesOpen, setFilesOpenRaw] = useState(false);
  const setChangesOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setChangesOpenRaw((o) => {
      const next = typeof v === "function" ? v(o) : v;
      if (next) setFilesOpenRaw(false);
      return next;
    });
  }, []);
  const setFilesOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setFilesOpenRaw((o) => {
      const next = typeof v === "function" ? v(o) : v;
      if (next) setChangesOpenRaw(false);
      return next;
    });
  }, []);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [router, setRouter] = useState<RouterStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalConfirm, setTerminalConfirm] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined);
  /** First-run welcome: shown while set. */
  const [welcome, setWelcome] = useState<OnboardingState | null>(null);
  const openSettings = useCallback((section?: SectionId) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const [settings, setSettings] = useState<PiSettings | null>(null);
  /** The shell could not start the sidecar (no node, node too old): the banner stays until dismissed. */
  const [startup, setStartup] = useState<StartupProblem | null>(null);
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
  const openingRef = useRef(false);
  const queuedOpenRef = useRef<string | null>(null);
  const openSessionRef = useRef<(path: string) => void>(() => {});
  const newSessionRef = useRef<(cwd: string) => void>(() => {});
  const [switching, setSwitching] = useState(false);
  const [layout, setLayoutState] = useState<SidebarState>({ groups: [], projects: [] });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
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
  /** Sessions the sidecar keeps in memory, by sessionId: background runs and finished-unseen ones. */
  const [bg, setBg] = useState<Record<string, { path: string; cwd: string; title: string; status: SessionStatus }>>({});
  /** Switching would exceed the local background limit: which run to stop, and the switch to retry. */
  const [limitAsk, setLimitAsk] = useState<{ block: BackgroundBlock; retry: ClientCommandInput } | null>(null);
  const sessionIdRef = useRef("");
  sessionIdRef.current = state.sessionId;
  const sessionPathRef = useRef("");
  sessionPathRef.current = state.sessionPath;
  const sessionsRef = useRef(state.sessions);
  sessionsRef.current = state.sessions;
  /** The sidecar died: session to reopen once a new one is up ("" = none; null = not down), and whether a run was cut. */
  const reopenRef = useRef<{ path: string; cut: boolean } | null>(null);
  const busyRef = useRef(false);
  busyRef.current = state.busy;
  const lastOpenRef = useRef("");
  /**
   * Session being left: its events already in the pipe when the switch started would land in
   * the next session's view. Dropped until the next session's history / init_done arrives.
   */
  const leavingRef = useRef("");
  const lastNewRef = useRef<string | undefined>(undefined);
  /** Find in transcript (Ctrl+F): null = closed; focus bumps on every Ctrl+F. */
  const [find, setFind] = useState<{ query: string; cur: number; focus: number } | null>(null);

  const send = useCallback((cmd: Parameters<PiTransport["send"]>[0]) => transportRef.current?.send(cmd), []);
  /** Every "open in terminal" entry (topbar, Ctrl K, TUI-only /commands) goes through this: the one-time warning first, then terminal_open. */
  const openInTerminal = () => {
    if (!state.sessionPath || state.terminalOpen) return;
    if (isTerminalWarnHidden()) return void send({ cmd: "terminal_open" });
    setTerminalConfirm(true);
  };
  const requestsRef = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }[]>());
  /** Reply as a promise. Replies carry the command name, not the id: same-name requests are answered in order. */
  const request = useCallback<PiRequest>(
    <T,>(cmd: Parameters<PiTransport["send"]>[0]) =>
      new Promise<T>((resolve, reject) => {
        if (!transportRef.current) return reject(new Error(t("brak połączenia z pi")));
        const queue = requestsRef.current.get(cmd.cmd) ?? [];
        queue.push({ resolve: resolve as (v: unknown) => void, reject });
        requestsRef.current.set(cmd.cmd, queue);
        transportRef.current.send(cmd);
      }),
    [],
  );

  const toast = useCallback((text: string, level: InfoLevel = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-3), { id, text, level }]);
    // Errors stay until closed; the rest fades out.
    if (level !== "error") setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6000);
  }, []);

  // A run may have created/renamed a session — refresh the sidebar after every settled.
  useEffect(() => {
    if (state.settledCount > 0) send({ cmd: "sessions_list" });
  }, [state.settledCount, send]);

  useEffect(() => {
    // In the Tauri shell the sidecar is spawned by Rust (stdio); in the
    // browser we go through the local WS dev bridge.
    const tp: PiTransport = inTauri() ? createTauriTransport() : createWsTransport(`ws://127.0.0.1:${import.meta.env.VITE_BRIDGE_PORT ?? 9877}`);
    transportRef.current = tp;
    imageStore.setFetcher((ref) => tp.send({ cmd: "history_image", ref }));
    const off = tp.onMessage((msg) => {
      if ("event" in msg) {
        const e = msg.event;
        if (e.kind === "voice") {
          pushVoiceLevel(e.level, e.live);
          return;
        }
        if (e.kind === "session_status") {
          setBg((b) => ({ ...b, [e.session]: { path: e.path, cwd: e.cwd, title: e.title, status: e.status } }));
          if (e.session === sessionIdRef.current) return;
          // Background session: the sidebar shows it; these need the user.
          const name = e.title || t("Sesja w tle");
          const notifyOn = prefsRef.current.notifications;
          if (e.status === "approval") {
            toast(t("Sesja „{name}” w tle czeka na zgodę.", { name }), "warning");
            if (notifyOn) tp.send({ cmd: "notify", title: t("pi czeka na zgodę"), body: t("Sesja „{name}” w tle prosi o zgodę.", { name }) });
          } else if (e.status === "done" || e.status === "error") {
            toast(e.status === "done" ? t("Sesja „{name}” skończyła w tle.", { name }) : t("Sesja „{name}” w tle skończyła z błędem.", { name }), e.status === "done" ? "info" : "warning");
            if (notifyOn && !document.hasFocus()) tp.send({ cmd: "notify", title: t("pi skończył w tle"), body: name });
            tp.send({ cmd: "sessions_list" });
          }
          return;
        }
        if (msg.session && msg.session === leavingRef.current && e.kind !== "history" && e.kind !== "init_done") return;
        if (e.kind === "history" || e.kind === "init_done") leavingRef.current = "";
        if (e.kind === "session_closed") {
          setBg((b) => {
            const { [e.session]: _gone, ...rest } = b;
            return rest;
          });
          return;
        }
        switch (e.kind) {
          case "notice":
            if (commandOutputRef.current) dispatch({ type: "info", text: e.text, level: e.level });
            else toast(e.text, e.level);
            return;
          case "memory":
            if (e.added.length)
              toast(
                `${plural(e.added.length, ["Zapamiętano:", "Zapamiętano {n} fakty:", "Zapamiętano {n} faktów:"], ["Remembered:", "Remembered {n} facts:"])} ${e.added.map((x) => x.text).join(" · ")}`,
              );
            return;
          case "editor_text":
            setInput(e.text);
            requestAnimationFrame(() => inputRef.current?.focus());
            return;
          case "session_changed":
            dispatch({ type: "clear" });
            tp.send({ cmd: "history" });
            tp.send({ cmd: "sessions_list" });
            return;
          case "init_done":
            // Extensions, templates and skills are per project — refresh "/" on every (re)init.
            tp.send({ cmd: "commands_list" });
            break;
          case "settled":
            commandOutputRef.current = false;
            break;
          case "terminal_state":
            // The terminal died or the session did not come back: the sidecar's error, not a toast that fades.
            if (e.error) toast(e.error, "error");
            break;
          case "history":
            imageStore.clear();
            atBottomRef.current = true;
            setAtBottom(true);
            break;
        }
        dispatch({ type: "event", event: e, at: Date.now() });
        return;
      }
      const pending = msg.cmd ? requestsRef.current.get(msg.cmd)?.shift() : undefined;
      if (pending) {
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error));
        return;
      }
      const blocked = msg.ok && (msg.cmd === "session_open" || msg.cmd === "session_new") ? (msg.result as { blocked?: BackgroundBlock }).blocked : undefined;
      if (blocked) {
        // Nothing switched: the limit dialog decides. session_new already cleared the view — restore it.
        openingRef.current = false;
        queuedOpenRef.current = null;
        leavingRef.current = "";
        setSwitching(false);
        setLimitAsk({ block: blocked, retry: msg.cmd === "session_open" ? { cmd: "session_open", path: lastOpenRef.current } : { cmd: "session_new", cwd: lastNewRef.current } });
        if (msg.cmd === "session_new") tp.send({ cmd: "history" });
        return;
      }
      if (msg.cmd === "session_open") {
        openingRef.current = false;
        setSwitching(false);
        const next = queuedOpenRef.current;
        queuedOpenRef.current = null;
        if (next) openSessionRef.current(next);
      }
      if (!msg.ok) {
        if (msg.cmd === "compact") {
          setCompacting(false);
          afterHistoryRef.current = [];
        }
        if (msg.cmd === "fork_points") setForkPoints([]);
        if (msg.cmd === "history_image") return; // stale ref after a session switch — nothing to show
        if (msg.cmd === "session_handoff") {
          dispatch({ type: "event", event: { kind: "settled" }, at: Date.now() });
          // The sidecar words it in the UI language: "handoff przerwany" / "handoff cancelled".
          if (/przerwany|cancelled/.test(msg.error ?? "")) {
            dispatch({ type: "info", text: t("Handoff przerwany — zostajesz w tej sesji."), level: "warning" });
            return;
          }
        }
        if (msg.cmd === "appearance_image") setImageBusy(false);
        if (isNoModelFailure(msg.error ?? "")) {
          // pi quotes the SDK's docs path and a /login lecture; the model chip and Settings are
          // the whole story here, so the chat gets one line and the bar stays clean.
          dispatch({ type: "info", text: noModelInfo(), level: "warning" });
          return;
        }
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
        // sidebar_set replies are ignored like appearance_set: the edit is already on screen.
        case "sidebar_get":
          setLayoutState(msg.result as SidebarState);
          return;
        case "session_delete": {
          const { path, active } = msg.result as { path: string; active: boolean };
          setLayoutState((l) => moveToGroup(l, path, null));
          if (active) resetViewRef.current();
          tp.send({ cmd: "sessions_list" });
          toast(t("Czat przeniesiony do kosza systemowego."));
          return;
        }
        case "history_image": {
          const img = msg.result as Attachment;
          if (img.ref) imageStore.resolve(img.ref, img);
          return;
        }
        case "commands_list":
          setPiCommands(msg.result as SlashCommandInfo[]);
          return;
        case "reload":
          setPiCommands(msg.result as SlashCommandInfo[]);
          dispatch({ type: "info", text: t("Przeładowano rozszerzenia, skille, szablony i pliki kontekstu.") });
          return;
        case "fork_points":
          setForkPoints(msg.result as ForkPoint[]);
          return;
        case "session_fork":
          setInput((msg.result as { text: string }).text);
          afterHistoryRef.current = [{ role: "info", text: t("Nowa sesja od wybranej wiadomości — wiadomość czeka w polu do poprawienia."), level: "info" }];
          tp.send({ cmd: "history" });
          tp.send({ cmd: "sessions_list" });
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        case "session_handoff": {
          const { prompt, from } = msg.result as { prompt: string; from: string };
          dispatch({ type: "event", event: { kind: "settled" }, at: Date.now() });
          resetView();
          setInput(prompt);
          const text = from
            ? t("Handoff z sesji „{from}”: model napisał prompt dla tej nowej sesji — czeka w polu wiadomości. Popraw go i wyślij Enterem.", { from })
            : t("Handoff z poprzedniej sesji: model napisał prompt dla tej nowej sesji — czeka w polu wiadomości. Popraw go i wyślij Enterem.");
          afterHistoryRef.current = [{ role: "info", text, level: "info" }];
          tp.send({ cmd: "history" });
          tp.send({ cmd: "sessions_list" });
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        }
        case "session_clone":
          afterHistoryRef.current = [{ role: "info", text: t("To jest kopia sesji — oryginał został bez zmian."), level: "info" }];
          tp.send({ cmd: "history" });
          tp.send({ cmd: "sessions_list" });
          return;
        case "session_stats":
          dispatch({ type: "info", text: formatStats(msg.result as SessionStats) });
          return;
        case "export_html":
          dispatch({ type: "info", text: `${t("Zapisano sesję jako HTML:")}\n\n\`${(msg.result as { path: string }).path}\`` });
          return;
        case "models_list":
          dispatch({ type: "models", models: msg.result as ModelSummary[] });
          return;
        case "session_rename":
          tp.send({ cmd: "sessions_list" });
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
          tp.send({ cmd: "git_changes" });
          return;
        case "compact":
          setSettings(msg.result as PiSettings);
          setCompacting(false);
          if (afterHistoryRef.current.length) afterHistoryRef.current.push({ role: "info", text: t("Kontekst skompaktowany."), level: "info" });
          tp.send({ cmd: "history" });
          return;
        case "rewind":
          setInput((msg.result as { text: string }).text);
          tp.send({ cmd: "history" });
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
      }
    });
    const offOpen = tp.onOpen(() => {
      // Boot (or re-boot after bridge restart): init is idempotent in the sidecar.
      tp.send({ cmd: "appearance_get" });
      tp.send({ cmd: "init", lang: lang() });
      tp.send({ cmd: "commands_list" });
      // After a sidecar restart: back to the session that was on screen (commands run in order,
      // so the history below is already the reopened session's).
      const reopen = reopenRef.current;
      reopenRef.current = null;
      if (reopen) {
        if (reopen.path) {
          lastOpenRef.current = reopen.path;
          tp.send({ cmd: "session_open", path: reopen.path });
        }
        afterHistoryRef.current = [
          reopen.cut
            ? { role: "info", text: t("pi działa ponownie. Przerwana odpowiedź nie została dokończona — napisz „dalej”, żeby wznowić."), level: "warning" }
            : { role: "info", text: t("pi działa ponownie."), level: "info" },
        ];
      }
      tp.send({ cmd: "history" });
      tp.send({ cmd: "sessions_list" });
      tp.send({ cmd: "models_list" });
      tp.send({ cmd: "sidebar_get" });
    });
    const offDown = tp.onDown((down) => {
      // Saved sessions only: an unsaved one has no file to reopen.
      const path = sessionPathRef.current;
      reopenRef.current = { path: path && sessionsRef.current.some((x) => x.path === path) ? path : "", cut: busyRef.current };
      for (const queue of requestsRef.current.values()) queue.splice(0).forEach((r) => r.reject(new Error(t("pi przestał działać"))));
      openingRef.current = false;
      queuedOpenRef.current = null;
      setSwitching(false);
      dispatch({ type: "connected", ok: false });
      // The restart itself failed (node gone or too old): the banner names the fix, the line here
      // only points at it. Otherwise the exit code, worded in the UI language.
      if (down.startup) setStartup(down.startup);
      const text = down.startup
        ? t("Proces pi (sidecar) nie wstał ponownie — powód i poprawka są nad czatem.")
        : down.restarting
          ? t("Proces pi (sidecar) zakończył się ({why}) — uruchamiam go ponownie…", { why: downReason(down) })
          : t("Proces pi (sidecar) zakończył się ({why}) i nie da się go podnieść. Uruchom Pi Code ponownie.", { why: downReason(down) });
      dispatch({ type: "info", text, level: "error" });
      toast(text, down.restarting ? "warning" : "error");
      // An older shell sends no `startup`, but records it all the same.
      if (!down.startup && !down.restarting) void readStartupProblem().then((p) => p && setStartup(p));
    });
    return () => {
      off();
      offOpen();
      offDown();
      tp.close();
      transportRef.current = null;
      imageStore.setFetcher(null);
    };
  }, []);

  // The shell starts the sidecar in `setup`, before this window listens to anything, so a start
  // failure is not an event we can miss — we ask for it.
  useEffect(() => {
    if (!inTauri()) return;
    void readStartupProblem().then((p) => p && setStartup(p));
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
          dispatch({ type: "error", error: `${t("obraz tła")}: ${err instanceof Error ? err.message : String(err)}` });
        });
    },
    [send],
  );

  // Changes panel: refresh when opened, after every run, and when a mutating tool finishes.
  const toolEnds = state.messages.reduce(
    (n, m) => n + (m.role === "assistant" ? m.parts.filter((p) => p.type === "tool" && p.tool.status !== "running").length : 0),
    0,
  );
  const gitIndex = (cmd: "git_stage" | "git_unstage", paths: string[]) => {
    setChangesLoading(true);
    request<GitChanges>({ cmd, paths }).then(setChanges, (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error")).finally(() => setChangesLoading(false));
  };
  const refreshChanges = useCallback(() => {
    setChangesLoading(true);
    send({ cmd: "git_changes" });
  }, [send]);
  useEffect(() => {
    if (changesOpen || filesOpen) refreshChanges();
  }, [changesOpen, filesOpen, toolEnds, state.settledCount, state.cwd, refreshChanges]);
  // The tree follows the project: new files after a run, another project after a switch.
  useEffect(() => {
    if (filesOpen) send({ cmd: "files_list" });
  }, [filesOpen, state.settledCount, state.cwd, send]);
  /** "@path " into the message at the caret (Files panel click). */
  const insertMention = useCallback((path: string) => {
    const el = inputRef.current;
    const token = `@${path} `;
    setInput((v) => {
      const at = el ? el.selectionStart : v.length;
      const before = v.slice(0, at);
      const pad = before && !/\s$/.test(before) ? " " : "";
      requestAnimationFrame(() => {
        el?.focus();
        const caret = at + pad.length + token.length;
        el?.setSelectionRange(caret, caret);
      });
      return `${before}${pad}${token}${v.slice(at)}`;
    });
  }, []);

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
    send({ cmd: "notify", title: t("pi skończył"), body: text.replace(/\s+/g, " ").slice(0, 140) || t("Gotowe.") });
  }, [state.settledCount, state.messages, send]);
  const approvalCount = state.approvals.length;
  useEffect(() => {
    if (approvalCount > 0 && !document.hasFocus() && prefsRef.current.notifications) {
      send({ cmd: "notify", title: t("pi czeka na zgodę"), body: `${state.approvals[0].toolName}: ${JSON.stringify(state.approvals[0].args).slice(0, 120)}` });
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

  const findHits = useMemo(() => (find ? hitsOf(findMatches(state.messages, find.query)) : []), [find?.query, state.messages]);
  const findHit = find && findHits.length ? findHits[Math.min(find.cur, findHits.length - 1)] : null;
  const findTarget = findHit ? { msg: findHit.msgIndex, part: findHit.partIndex } : null;
  const findScrolled = useRef("");
  // After the transcript rendered the hit's block expanded: highlight and scroll to it (once per hit).
  useLayoutEffect(() => {
    const col = columnRef.current;
    if (!find) {
      clearFind();
      findScrolled.current = "";
      return;
    }
    if (!col) return;
    const paint = () => {
      const { block, current } = paintFind(col, find.query, findHit);
      const key = findHit ? `${find.query}|${findHit.msgIndex}|${findHit.partIndex}|${findHit.field}|${findHit.occ}` : "";
      const el = scrollRef.current;
      if (!key || key === findScrolled.current || !el || !block) return;
      findScrolled.current = key;
      atBottomRef.current = false;
      setAtBottom(false);
      const box = (current ?? block).getBoundingClientRect();
      const view = el.getBoundingClientRect();
      if (box.top < view.top + 40 || box.bottom > view.bottom - 40) el.scrollTop += box.top - view.top - el.clientHeight / 3;
    };
    paint();
    // Code blocks are highlighted by shiki asynchronously — their text nodes get replaced.
    const id = window.setTimeout(paint, 200);
    return () => window.clearTimeout(id);
  });
  const stepFind = (dir: 1 | -1) =>
    setFind((f) => (f && findHits.length ? { ...f, cur: (Math.min(f.cur, findHits.length - 1) + dir + findHits.length) % findHits.length } : f));
  const openFind = useCallback(() => setFind((f) => ({ query: f?.query ?? "", cur: f?.cur ?? 0, focus: (f?.focus ?? 0) + 1 })), []);

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
    // Commands first: /login and /model are how a model gets picked, so they work without one.
    const slash = images ? null : parseSlash(text);
    if (slash) {
      runSlash(slash.name, slash.args);
      return;
    }
    if (!state.model) {
      // Nothing to send to (the wizard was skipped). pi answers this with a wall of paths, and the
      // fix is one setting away. The composer routes Enter to the setting; this guards other callers.
      dispatch({ type: "info", text: noModelHint(), level: "warning" });
      openSettings("providers");
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
        dispatch({ type: "error", error: `${t("obraz")}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }, []);

  const nativeImages = useCallback(
    async (get: () => Promise<File[]>) => {
      try {
        await addFiles(await get());
      } catch (err) {
        dispatch({ type: "error", error: `${t("obraz")}: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    [addFiles],
  );

  // Tauri takes file drops before the page sees them: the overlay and the files come from its event.
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    let gone = false;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter") setDragging(payload.paths.some(isImagePath));
        else if (payload.type === "leave") setDragging(false);
        else if (payload.type === "drop") {
          setDragging(false);
          void nativeImages(() => readImagePaths(payload.paths));
        }
      })
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  }, [nativeImages]);

  const setMode = useCallback(
    (mode: typeof state.mode) => {
      // Optimistic: rapid Shift+Tab presses must cycle from the new mode, not the stale one.
      dispatch({ type: "event", event: { kind: "mode", mode } });
      send({ cmd: "mode_set", mode });
    },
    [send],
  );

  const onThinking = useCallback(
    (level: string) => {
      // Optimistic, like setMode — the chip should flip instantly, not after a round trip.
      setSettings((s) => (s ? { ...s, thinking: { ...s.thinking, level } } : s));
      send({ cmd: "settings_set", patch: { thinkingLevel: level } });
    },
    [send],
  );

  const executePlan = () => {
    setMode("acceptEdits");
    const text = t("Wykonaj ten plan.");
    dispatch({ type: "user", text, at: Date.now() });
    send({ cmd: "prompt", text });
  };

  const stop = useCallback(() => send({ cmd: "abort" }), [send]);

  const resetViewRef = useRef<() => void>(() => {});
  const resetView = () => {
    dispatch({ type: "clear" });
    imageStore.clear();
    atBottomRef.current = true;
    setAtBottom(true);
  };

  resetViewRef.current = resetView;

  const newSession = useCallback(
    (cwd?: string) => {
      resetView();
      leavingRef.current = sessionIdRef.current;
      lastNewRef.current = cwd;
      send({ cmd: "session_new", cwd });
      send({ cmd: "sessions_list" });
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [send],
  );
  newSessionRef.current = newSession;

  /**
   * The old transcript stays until the sidecar sends the new one (a "history" event,
   * straight from the file) — no empty flash. Clicks during an open coalesce: only
   * the last one is opened next.
   */
  const setLayout = (next: SidebarState) => {
    setLayoutState(next);
    send({ cmd: "sidebar_set", state: next });
  };

  /**
   * Native folder picker in the app, a typed path in the browser build — or when the
   * native dialog fails (it used to fail silently). The sidecar checks the path.
   */
  const pickFolder = async (): Promise<string | null> => {
    let dir: string | null = null;
    if (inTauri()) {
      try {
        const picked = await openDialog({ directory: true, multiple: false, title: t("Wybierz folder projektu"), defaultPath: state.cwd || undefined });
        dir = typeof picked === "string" ? picked : null;
      } catch (e) {
        toast(t("Okno wyboru folderu nie zadziałało ({err}) — wpisz ścieżkę.", { err: e instanceof Error ? e.message : String(e) }), "warning");
        dir = window.prompt(t("Ścieżka folderu projektu"), state.cwd);
      }
    } else {
      dir = window.prompt(t("Ścieżka folderu projektu"), state.cwd);
    }
    if (!dir?.trim()) return null;
    return (await request<{ path: string }>({ cmd: "dir_check", path: dir.trim() })).path;
  };

  /** Sidebar "+" (just add) and the composer's "Inny folder…" (add and start a session there). */
  const addProjectFolder = async (start = false) => {
    try {
      const path = await pickFolder();
      if (!path) return;
      setLayout(addProject(layoutRef.current, path));
      if (start) newSessionRef.current(path);
      else toast(t("Dodano projekt {name} — „+” przy nim zaczyna nową sesję.", { name: basename(path) }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const openSession = (path: string) => {
    if (openingRef.current) {
      queuedOpenRef.current = path;
      return;
    }
    openingRef.current = true;
    setSwitching(true);
    lastOpenRef.current = path;
    leavingRef.current = sessionIdRef.current;
    send({ cmd: "session_open", path });
  };
  openSessionRef.current = openSession;

  // Settings are per session in part (thinking level, tools) — refetch on connect, session swap, model
  // switch, and dialog open. The composer's thinking chip needs this live, not just while the dialog is up.
  useEffect(() => {
    if (state.connected) send({ cmd: "settings_get" });
  }, [settingsOpen, state.connected, state.sessionPath, state.model, send]);

  // First run: the sidecar remembers whether the welcome was done (pi-gui.json), so it
  // shows once per machine, not per browser profile.
  useEffect(() => {
    if (!state.connected) return;
    request<OnboardingState>({ cmd: "onboarding_get" }).then(
      (o) => !o.done && setWelcome(o),
      () => undefined,
    );
  }, [state.connected, request]);

  const showWelcome = () => request<OnboardingState>({ cmd: "onboarding_get" }).then(setWelcome, () => undefined);
  const finishWelcome = () => {
    setWelcome(null);
    send({ cmd: "onboarding_done" });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // The tray menu is built in Rust, which does not know the UI language (again on a switch).
  useEffect(syncTrayLabels, []);

  // Rust owns the close button's behaviour; tell it the user's choice (and on every start).
  useEffect(() => {
    if (inTauri()) void invoke("set_close_to_tray", { enabled: prefs.closeToTray }).catch(() => undefined);
  }, [prefs.closeToTray]);

  /** Credentials or models.json changed: pi reloaded its model list, the composer follows. */
  const refreshModels = useCallback(() => {
    send({ cmd: "models_list" });
    send({ cmd: "settings_get" });
  }, [send]);

  /**
   * Labels are built at render time (no translated module constants), so a language switch is
   * one re-render: the version bump below is what makes React run it. The sidecar words its own
   * messages, so it is told too, and the settings snapshot is asked for again.
   */
  const [, setLangVersion] = useState(0);
  const changeLang = useCallback(
    (l: Lang) => {
      saveLang(l);
      document.documentElement.lang = l;
      send({ cmd: "lang_set", lang: l });
      send({ cmd: "settings_get" });
      syncTrayLabels();
      setLangVersion((v) => v + 1);
    },
    [send],
  );

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
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setChangesOpen((o) => !o);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setFilesOpen((o) => !o);
      } else if (e.key === "Tab" && e.shiftKey && !mod) {
        e.preventDefault();
        setMode(nextMode(state.mode));
      } else if (e.key === "Escape" && (state.busy || state.approvals.length > 0) && !e.defaultPrevented) {
        // A pending approval is denied by the stop (sidecar), whatever the UI thinks of the run.
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, toggleSidebar, stop, setMode, openFind, state.busy, state.approvals.length, state.mode, sidebarOpen]);

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
      info(t("Nie ma komendy `/{name}`. Wpisz `/`, żeby zobaczyć listę.", { name }), "warning");
      return;
    }
    if (entry.kind !== "gui" && entry.kind !== "terminal" && state.busy) {
      toast(t("Model pracuje — komendy pi uruchomisz, gdy skończy (Esc przerywa)."), "warning");
      return;
    }
    done();
    switch (entry.kind) {
      case "terminal":
        if (state.terminalOpen) {
          echo();
          info(t("Sesja jest już otwarta w terminalu — przejmij ją, żeby wrócić do GUI."), "warning");
          return;
        }
        echo();
        info(t("Otwieram sesję w terminalu (pi)…"));
        openInTerminal();
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
          info(t("Podaj nazwę: `/name Nowa nazwa`."), "warning");
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
          if (args) info(t("Nie znam modelu „{name}”.", { name: args }), "warning");
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
        toast(`${t("Myślenie")}: ${args}`);
        return;
      case "mode": {
        const q = args.toLowerCase();
        const all = modes();
        const m = all.find((x) => x.id.toLowerCase() === q || x.label.toLowerCase() === q) ?? all.find((x) => x.label.toLowerCase().includes(q));
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
      case "handoff":
        if (state.busy) {
          setInput(`/handoff${args ? ` ${args}` : ""}`);
          toast(t("Model pracuje — handoff zrobisz, gdy skończy."), "warning");
          return;
        }
        // Busy until the reply: the old transcript stays up while the model writes; Esc cancels.
        dispatch({ type: "command", text: `/handoff${args ? ` ${args}` : ""}`, run: true, at: Date.now() });
        dispatch({ type: "info", text: t("Model pisze handoff do nowej sesji…") });
        send({ cmd: "session_handoff", goal: args || undefined });
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
          toast(t("Nie ma jeszcze odpowiedzi do skopiowania."), "warning");
          return;
        }
        void copyText(text).then(() => toast(t("Skopiowano ostatnią odpowiedź.")));
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
        return modes().map((m) => ({ key: m.id, label: m.label, hint: m.desc, active: m.id === state.mode }));
      case "fork":
        return forkPoints?.map((f) => ({ key: f.entryId, label: f.text.replace(/\s+/g, " ").slice(0, 120) || t("(pusta wiadomość)") })) ?? null;
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
    { id: "new", group: t("Akcje"), label: t("Nowa sesja"), hint: <kbd>Ctrl N</kbd>, run: () => newSession() },
    { id: "files", group: t("Akcje"), label: filesOpen ? t("Ukryj pliki projektu") : t("Pokaż pliki projektu"), hint: <kbd>Ctrl Shift E</kbd>, run: () => setFilesOpen((o) => !o) },
    { id: "changes", group: t("Akcje"), label: changesOpen ? t("Ukryj panel zmian") : t("Pokaż panel zmian"), hint: <kbd>Ctrl Shift D</kbd>, run: () => setChangesOpen((o) => !o) },
    { id: "sidebar", group: t("Akcje"), label: sidebarOpen ? t("Zwiń panel sesji") : t("Pokaż panel sesji"), hint: <kbd>Ctrl B</kbd>, run: toggleSidebar },
    { id: "settings", group: t("Akcje"), label: t("Ustawienia"), hint: <kbd>Ctrl ,</kbd>, keywords: "settings konfiguracja", run: () => setSettingsOpen(true) },
    { id: "providers", group: t("Akcje"), label: t("Dostawcy modeli"), keywords: "providers api key openrouter vllm ollama klucz", run: () => openSettings("providers") },
    { id: "memory", group: t("Akcje"), label: t("Pamięć"), keywords: "memory pamięć zapamiętane agents.md", run: () => openSettings("memory") },
    { id: "welcome", group: t("Akcje"), label: t("Ekran powitalny"), keywords: "welcome onboarding powitanie start", run: () => void showWelcome() },
    { id: "compact", group: t("Akcje"), label: t("Kompaktuj kontekst"), keywords: "compact", run: () => { setCompacting(true); send({ cmd: "compact" }); } },
    { id: "stats", group: t("Akcje"), label: t("Statystyki modeli"), keywords: "stats statystyki prędkość t/s tokeny", run: () => setStatsOpen(true) },
    { id: "find", group: t("Akcje"), label: t("Szukaj w rozmowie"), hint: <kbd>Ctrl F</kbd>, keywords: "find search znajdź", run: openFind },
    ...(state.sessionPath && !state.terminalOpen
      ? [{ id: "terminal", group: t("Akcje"), label: t("Otwórz sesję w terminalu"), keywords: "terminal pi tui", run: openInTerminal }]
      : []),
    ...(state.terminalOpen
      ? [{ id: "terminal-takeback", group: t("Akcje"), label: t("Przejmij sesję z powrotem z terminala"), keywords: "terminal pi przejmij", run: () => send({ cmd: "terminal_takeback" }) }]
      : []),
    { id: "handoff", group: t("Akcje"), label: t("Handoff → nowa sesja"), keywords: "handoff podsumowanie przekazanie", run: () => runSlash("handoff", "") },
    ...(state.busy ? [{ id: "stop", group: t("Akcje"), label: t("Przerwij model"), hint: <kbd>Esc</kbd>, run: stop }] : []),
    ...modes().map((m) => ({
      id: `mode-${m.id}`,
      group: t("Tryb uprawnień"),
      label: m.label,
      hint: m.id === state.mode ? t("aktywny") : m.desc,
      keywords: "tryb mode",
      run: () => setMode(m.id),
    })),
    ...state.models.map((m) => ({
      id: `model-${m.provider}/${m.id}`,
      group: "Model",
      label: m.id,
      hint: m.id === state.model ? t("aktywny") : formatTokens(m.contextWindow),
      keywords: "model",
      run: () => send({ cmd: "model_set", provider: m.provider, modelId: m.id }),
    })),
    ...state.sessions.slice(0, 200).map((s) => ({
      id: `session-${s.path}`,
      group: t("Sesje"),
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
  const title = state.sessionName || (active ? sessionTitle(active) : "") || firstUserText(state) || t("Nowa sesja");

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
      onPasteNative={inTauri() ? () => void nativeImages(async () => [await clipboardImage()].filter((f): f is File => f !== null)) : undefined}
      onPickImages={inTauri() ? () => void nativeImages(() => pickImages(t("Dołącz obraz"), t("Obrazy"))) : undefined}
      onRemoveAttachment={(i) => setAttachments((cur) => cur.filter((_, j) => j !== i))}
      blocked={Boolean(approval) || state.terminalOpen}
      files={files}
      onNeedFiles={() => send({ cmd: "files_list" })}
      model={state.model}
      provider={state.provider}
      models={state.models}
      onModel={(m) => send({ cmd: "model_set", provider: m.provider, modelId: m.id })}
      onProviders={() => openSettings("providers")}
      thinking={settings?.thinking ?? null}
      onThinking={onThinking}
      cwd={state.cwd}
      branch={state.branch}
      sessions={state.sessions}
      onProject={(cwd) => newSession(cwd)}
      onPickFolder={() => void addProjectFolder(true)}
      usage={state.usage}
      inputRef={inputRef}
      hero={empty}
      commands={slashCommands}
      pickItems={pickItems}
      onNeedPick={onNeedPick}
      onCommand={runSlash}
      addons={settings?.gui ?? null}
      extensions={settings?.extensions.map((e) => e.name)}
      onAddonsPatch={(patch) => send({ cmd: "settings_set", patch })}
      onAddonsSettings={() => openSettings("constitution")}
      request={request}
      onDictationError={(msg) => toast(msg, "warning")}
      onDictationSetup={() => openSettings("voice")}
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
          <span>{t("Upuść obraz, żeby dołączyć go do wiadomości")}</span>
        </div>
      )}
      {sidebarOpen && (
        <Sidebar
          sessions={withLiveSessions(state.sessions, bg)}
          loading={state.loadingSessions}
          activePath={state.sessionPath}
          busyPath={state.busy ? state.sessionPath : ""}
          statuses={Object.fromEntries(Object.values(bg).map((b) => [b.path, b.status]))}
          onStop={(path) => {
            const id = Object.entries(bg).find(([, b]) => b.path === path)?.[0];
            if (id) send({ cmd: "abort", session: id });
          }}
          onOpen={openSession}
          onNew={() => newSession()}
          onCollapse={toggleSidebar}
          onSettings={() => setSettingsOpen(true)}
          onStats={() => setStatsOpen(true)}
          searchRef={searchRef}
          user={state.user}
          layout={layout}
          onLayout={setLayout}
          onNewIn={(cwd) => newSession(cwd)}
          onAddProject={() => void addProjectFolder()}
          onDelete={setDeleting}
        />
      )}

      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          {!sidebarOpen && (
            <button className="icon-btn" onClick={toggleSidebar} title={t("Pokaż panel (Ctrl+B)")}>
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
            className="icon-btn"
            onClick={openInTerminal}
            disabled={!state.sessionPath || state.terminalOpen}
            title={t("Otwórz sesję w terminalu")}
          >
            <SquareTerminal size={16} />
          </button>
          <button className={`icon-btn ${filesOpen ? "on" : ""}`} onClick={() => setFilesOpen((o) => !o)} title={t("Pliki projektu (Ctrl+Shift+E)")}>
            <FolderTree size={16} />
          </button>
          <button
            className={`icon-btn ${changesOpen ? "on" : ""}`}
            onClick={() => setChangesOpen((o) => !o)}
            title={t("Zmiany w projekcie (Ctrl+Shift+D)")}
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
            {state.connected ? "pi" : t("łączenie…")}
          </span>
          {inTauri() && <WindowControls />}
        </header>

        {startup && <StartupBanner problem={startup} onDismiss={() => setStartup(null)} />}

        {state.error && (
          <div className="error-bar">
            <span>{state.error}</span>
            <button className="icon-btn" onClick={() => dispatch({ type: "error", error: null })} title={t("Zamknij")}>
              <X size={14} />
            </button>
          </div>
        )}

        {find && !empty && (
          <FindBar
            query={find.query}
            onQuery={(query) => setFind((f) => (f ? { ...f, query, cur: 0 } : f))}
            current={findHit ? Math.min(find.cur, findHits.length - 1) : 0}
            total={findHits.length}
            onStep={stepFind}
            onClose={() => setFind(null)}
            focusKey={find.focus}
          />
        )}

        {empty ? (
          <div className="hero">
            <Logo size={60} className="hero-mark" />
            <h1>{t("Co dalej?")}</h1>
            {dialog && <ExtensionDialog key={dialog.id} request={dialog} queued={state.dialogs.length - 1} onAnswer={answerDialog} />}
            {state.terminalOpen && <TerminalBar onTakeback={() => send({ cmd: "terminal_takeback" })} />}
            {composer}
            {state.cwd && (
              <button className="hero-folder" onClick={() => void addProjectFolder(true)} title={t("Model pracuje na plikach w tym folderze")}>
                <FolderOpen size={13} />
                <span className="hf-path">{state.cwd.replace(/^\/home\/[^/]+/, "~")}</span>
                <span className="hf-change">{t("zmień folder")}</span>
              </button>
            )}
            <RecentProjects sessions={state.sessions} current={state.cwd} onOpen={openSession} onNew={(cwd) => newSession(cwd)} />
            <div className="hero-hints">
              <kbd>/</kbd> {t("komendy")} · <kbd>Ctrl N</kbd> {t("nowa sesja")} · <kbd>Ctrl K</kbd> {t("szukaj")} · <kbd>Ctrl B</kbd> {t("panel")}
            </div>
          </div>
        ) : (
          <>
            <div className={`scroll ${switching ? "switching" : ""}`} ref={scrollRef} onScroll={onScroll}>
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
                  findTarget={findTarget}
                />
              </div>
            </div>
            <div className="dock">
              {!atBottom && (
                <button className="to-bottom" onClick={scrollToBottom} title={t("Przewiń na dół")}>
                  <ArrowDown size={16} />
                </button>
              )}
              {state.stuck && !state.busy && (
                <StuckCard
                  stuck={state.stuck}
                  onEscalate={() => {
                    const model = state.stuck!.suggest;
                    dispatch({ type: "user", text: t("↗ Przekaż zadanie modelowi {model} (poprzedni utknął)", { model: model.split("/").pop() ?? model }), at: Date.now() });
                    send({ cmd: "escalate", model, reason: state.stuck!.label });
                  }}
                  onSettings={() => setSettingsOpen(true)}
                  onDismiss={() => dispatch({ type: "unstuck" })}
                />
              )}
              {dialog && <ExtensionDialog key={dialog.id} request={dialog} queued={state.dialogs.length - 1} onAnswer={answerDialog} />}
              {state.terminalOpen && <TerminalBar onTakeback={() => send({ cmd: "terminal_takeback" })} />}
              {approval && (
                <ApprovalCard
                  approval={approval}
                  queued={state.approvals.length - 1}
                  cwd={state.cwd}
                  onDecide={decide}
                  reasonDraft={input}
                />
              )}
              {state.busy && !approval && <Working since={state.busySince} now={now} perf={state.perf} steps={state.steps} />}
              {composer}
            </div>
          </>
        )}
      </main>
      {filesOpen && (
        <FilesPanel
          files={files}
          changes={changes}
          cwd={state.cwd}
          onRefresh={() => {
            setFiles(null);
            send({ cmd: "files_list" });
            refreshChanges();
          }}
          onInsert={insertMention}
          onClose={() => setFilesOpen(false)}
        />
      )}
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
          onStage={(paths) => gitIndex("git_stage", paths)}
          onUnstage={(paths) => gitIndex("git_unstage", paths)}
          onCommit={(message) =>
            request<{ commit: string; subject: string; changes: GitChanges }>({ cmd: "git_commit", message }).then((r) => {
              setChanges(r.changes);
              toast(t("Zatwierdzono {commit}: {subject}", { commit: r.commit, subject: r.subject }));
            })
          }
          onSuggest={() => request<{ message: string }>({ cmd: "git_commit_message" }).then((r) => r.message)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("Usunąć czat?")}
          confirmLabel={t("Usuń")}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            send({ cmd: "session_delete", path: deleting.path });
            setDeleting(null);
          }}
        >
          {t("„{title}” ({folder}) trafi do kosza systemowego — da się go stamtąd przywrócić.", { title: sessionTitle(deleting), folder: basename(deleting.cwd) })}
          {deleting.path === state.sessionPath && state.busy && ` ${t("Model w tym czacie zostanie zatrzymany.")}`}
        </ConfirmDialog>
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
          request={request}
          initialSection={settingsSection}
          onSessionsChanged={() => send({ cmd: "sessions_list" })}
          onProvidersChanged={refreshModels}
          onLang={changeLang}
        />
      )}
      {welcome && (
        <Welcome
          info={welcome}
          request={request}
          models={state.models}
          model={state.model}
          provider={state.provider}
          cwd={state.cwd}
          projects={[...new Set(state.sessions.map((x) => x.cwd).filter(Boolean))]}
          onModel={(m) => send({ cmd: "model_set", provider: m.provider, modelId: m.id })}
          onDefaultModel={(key) => send({ cmd: "settings_set", patch: { defaultModel: key } })}
          onProvidersChanged={refreshModels}
          onPickFolder={pickFolder}
          onFolder={(dir) => {
            setLayout(addProject(layoutRef.current, dir));
            newSessionRef.current(dir);
          }}
          onLang={changeLang}
          onDone={finishWelcome}
        />
      )}
      {limitAsk && (
        <LimitDialog
          block={limitAsk.block}
          onCancel={() => setLimitAsk(null)}
          onStop={(session) => {
            const retry = limitAsk.retry;
            setLimitAsk(null);
            if (retry.cmd === "session_open") {
              leavingRef.current = sessionIdRef.current;
              openingRef.current = true;
              setSwitching(true);
              send({ ...retry, stop: session });
            } else if (retry.cmd === "session_new") {
              resetView();
              leavingRef.current = sessionIdRef.current;
              send({ ...retry, stop: session });
              send({ cmd: "sessions_list" });
            }
          }}
        />
      )}
      {statsOpen && <StatsDialog request={request} onClose={() => setStatsOpen(false)} />}
      {terminalConfirm && (
        <TerminalOpenDialog
          fork={Boolean(settings?.gui.terminalFork)}
          onOpen={(dont) => {
            if (dont) markTerminalWarnHidden();
            setTerminalConfirm(false);
            void send({ cmd: "terminal_open" });
          }}
          onCancel={() => setTerminalConfirm(false)}
        />
      )}
      <Toasts toasts={toasts} onClose={(id) => setToasts((ts) => ts.filter((x) => x.id !== id))} />
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
        <b>{t("Model utknął.")}</b> {stuck.label}.{" "}
        {stuck.suggest ? t("Możesz przekazać zadanie mocniejszemu modelowi.") : t("Nie ustawiono modelu do eskalacji.")}
      </div>
      <div className="stuck-actions">
        {stuck.suggest ? (
          <button className="btn primary" onClick={onEscalate}>
            {t("Przekaż do {model}", { model: stuck.suggest.split("/").pop() ?? stuck.suggest })}
          </button>
        ) : (
          <button className="btn" onClick={onSettings}>
            {t("Ustaw model do eskalacji")}
          </button>
        )}
        <button className="btn" onClick={onDismiss}>
          {t("Zamknij")}
        </button>
      </div>
    </div>
  );
}

/** The tray menu is built in Rust, which does not know the UI language. */
function syncTrayLabels(): void {
  if (inTauri()) void invoke("set_tray_labels", { show: t("Pokaż Pi Code"), quit: t("Zakończ") }).catch(() => undefined);
}

function formatStats(st: SessionStats): string {
  const tok = st.tokens;
  const lines = [
    `**${t("Sesja")}**`,
    `- ${t("wiadomości: {user} Twoich, {assistant} modelu, {tools} wywołań narzędzi", { user: st.userMessages, assistant: st.assistantMessages, tools: st.toolCalls })}`,
    `- ${t("tokeny: {input} wejście", { input: formatTokens(tok.input) })}${tok.cacheRead ? ` ${t("(z cache {cache})", { cache: formatTokens(tok.cacheRead) })}` : ""}, ${t("{output} wyjście, razem {total}", { output: formatTokens(tok.output), total: formatTokens(tok.total) })}`,
  ];
  if (st.cost > 0) lines.push(`- ${t("koszt")}: $${st.cost.toFixed(4)}`);
  if (st.sessionFile) lines.push(`- ${t("plik")}: \`${st.sessionFile.replace(/^\/home\/[^/]+/, "~")}\``);
  return lines.join("\n");
}

function firstUserText(state: { messages: { role: string; text?: string }[] }): string {
  const m = state.messages.find((x) => x.role === "user");
  return m?.text?.replace(/\s+/g, " ").slice(0, 80) ?? "";
}

/** One status line above the composer while a run works: "✻ Generuje · 1:42 · krok 5 · 38 t/s". */
function Working({ since, now, perf, steps }: { since: number | null; now: number; perf: LivePerf | null; steps: number }) {
  let label = t("Pracuje");
  let speed: string | null = null;
  let detail = "";
  let progress: number | null = null;
  if (perf?.phase === "waiting") {
    label = t("Czeka na slot");
    detail = t("model liczy teraz dla innej sesji; ta ruszy, gdy tamta skończy zapytanie");
  } else if (perf?.phase === "prompt") {
    const fresh = perf.total - perf.cache;
    const done = perf.processed - perf.cache;
    progress = fresh > 0 ? Math.min(1, done / fresh) : 1;
    label = t("Czyta kontekst");
    speed = `${Math.round(progress * 100)}%`;
    detail =
      `${formatTokens(fresh)} tok` +
      (perf.cache > 0 ? ` (cache ${formatTokens(perf.cache)})` : "") +
      (perf.perSec > 0 ? ` · PP ${Math.round(perf.perSec)} t/s` : "");
  } else if (perf?.phase === "gen") {
    label = t("Generuje");
    speed = `${perf.perSec.toFixed(1).replace(".", ",")} t/s`;
    detail = `${perf.tokens} tok`;
  }
  return (
    <div className="working" title={detail || undefined}>
      <span className="working-star">✻</span>
      <span className="shimmer">{label}</span>
      {since !== null && <span className="working-sep">·</span>}
      {since !== null && <span className="working-time">{formatDuration(now - since)}</span>}
      {steps > 0 && <span className="working-sep">·</span>}
      {steps > 0 && <span className="working-steps">{t("krok {n}", { n: steps })}</span>}
      {speed && <span className="working-sep">·</span>}
      {speed && <span className="working-perf">{speed}</span>}
      {detail && <span className="working-detail">{detail}</span>}
      <span className="working-hint">
        <kbd>Esc</kbd> {t("przerwij")}
      </span>
      {progress !== null && (
        <span className="working-bar">
          <span style={{ width: `${progress * 100}%` }} />
        </span>
      )}
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
        title={t("Kliknij, aby zmienić nazwę")}
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

/**
 * pi writes a session file only after the first answer, so a session sent to the background
 * during its first run is not in sessions_list yet — it still needs a row to come back to.
 */
function withLiveSessions(
  sessions: SessionSummary[],
  bg: Record<string, { path: string; cwd: string; title: string; status: SessionStatus }>,
): SessionSummary[] {
  const known = new Set(sessions.map((s) => s.path));
  const extra = Object.entries(bg)
    .filter(([, b]) => b.path && !known.has(b.path) && b.status !== "idle")
    .map(([id, b]): SessionSummary => ({ path: b.path, id, cwd: b.cwd, modified: new Date().toISOString(), messageCount: 1, firstMessage: b.title }));
  return extra.length ? [...extra, ...sessions] : sessions;
}

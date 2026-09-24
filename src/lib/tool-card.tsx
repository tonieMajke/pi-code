import { FilePenLine, FileText, Folder, Globe, Search, Terminal, Wrench } from "lucide-react";
import type { ToolItem } from "./reducer";

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileText,
  write: FilePenLine,
  edit: FilePenLine,
  bash: Terminal,
  glob: Folder,
  grep: Search,
  web_search: Globe,
  fetch_content: Globe,
  source_check: Globe,
};

export function toolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const Icon = toolIcon(tool.name);
  const argLine = summarizeArgs(tool.args);
  return (
    <details className={`tool ${tool.status}`} open={tool.status === "running"}>
      <summary>
        {tool.status === "running" && <span className="spinner" />}
        <Icon size={14} className="tool-icon" />
        <span className="tool-name">{tool.name}</span>
        {argLine && <span className="tool-args">{argLine}</span>}
        {tool.status === "error" && <span className="tool-err">błąd</span>}
      </summary>
      <pre className="tool-result">{tool.summary || (tool.status === "running" ? "wykonywanie…" : "")}</pre>
    </details>
  );
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["path", "file", "command", "query", "url"]) {
    const v = a[key];
    if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return "";
}

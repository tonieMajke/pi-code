// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import type { SessionSummary, SidebarState } from "../../shared/protocol";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const now = new Date().toISOString();
const S: SessionSummary[] = [
  { path: "/s/a.jsonl", id: "a", cwd: "/home/u/blender", modified: now, messageCount: 2, firstMessage: "Zrób kubek" },
  { path: "/s/b.jsonl", id: "b", cwd: "/home/u/pi-gui", modified: now, messageCount: 2, firstMessage: "Popraw testy" },
];

function Harness({ initial, onDelete, onNewIn }: { initial: SidebarState; onDelete: (s: SessionSummary) => void; onNewIn: (cwd: string) => void }) {
  const [layout, setLayout] = useState(initial);
  return (
    <Sidebar
      sessions={S}
      loading={false}
      activePath=""
      busyPath=""
      onOpen={vi.fn()}
      onNew={vi.fn()}
      onCollapse={vi.fn()}
      onSettings={vi.fn()}
      searchRef={{ current: null }}
      user="u"
      layout={layout}
      onLayout={setLayout}
      onNewIn={onNewIn}
      onAddProject={vi.fn()}
      onDelete={onDelete}
    />
  );
}

function setup(initial: SidebarState = { groups: [], projects: [] }) {
  const onDelete = vi.fn();
  const onNewIn = vi.fn();
  render(<Harness initial={initial} onDelete={onDelete} onNewIn={onNewIn} />);
  return { onDelete, onNewIn };
}

describe("Sidebar", () => {
  it("right-click menu moves a chat into a group; it then lives only there", () => {
    setup({ groups: [{ id: "g", name: "Modele 3D", sessions: [] }], projects: [] });
    fireEvent.contextMenu(screen.getByText("Zrób kubek"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Modele 3D" }));
    const group = screen.getByText("Modele 3D").closest("section")!;
    expect(within(group).getByText("Zrób kubek")).toBeTruthy();
    expect(screen.getAllByText("Zrób kubek")).toHaveLength(1);
  });

  it("new group from a chat's menu asks for a name", () => {
    setup();
    fireEvent.contextMenu(screen.getByText("Popraw testy"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Nowa grupa…" }));
    const input = screen.getByLabelText("Nazwa grupy");
    fireEvent.change(input, { target: { value: "Poprawki" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(screen.getByText("Poprawki").closest("section")!).getByText("Popraw testy")).toBeTruthy();
  });

  it("delete goes through the parent (confirmation lives there)", () => {
    const { onDelete } = setup();
    fireEvent.contextMenu(screen.getByText("Zrób kubek"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Usuń czat…" }));
    expect(onDelete).toHaveBeenCalledWith(S[0]);
  });

  it("projects view: one section per folder, added empty projects too, '+' starts a session there", () => {
    const { onNewIn } = setup({ groups: [], projects: ["/home/u/nowy"] });
    fireEvent.click(screen.getByRole("tab", { name: "Projekty" }));
    for (const name of ["blender", "pi-gui", "nowy"]) expect(screen.getByText(name)).toBeTruthy();
    fireEvent.click(screen.getByTitle("Nowa sesja w nowy"));
    expect(onNewIn).toHaveBeenCalledWith("/home/u/nowy");
    // Collapsing hides the chats of that project.
    fireEvent.click(screen.getByText("blender"));
    expect(screen.queryByText("Zrób kubek")).toBeNull();
  });
});

/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useProjectBoard } from "./useProjectBoard.ts";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";

test("board restores the previously loaded window through real page cursors instead of losing deep reading position", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const saved = Object.fromEntries(["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, (globalThis as any)[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: string[] = [];
  dom.window.butlerApp = { getProjectDashboardResource: async ({ query }: { query: string }) => {
    const cursor = new URLSearchParams(query).get("cursor") ?? "first"; calls.push(cursor);
    const offset = cursor === "first" ? 0 : cursor === "second" ? 50 : 100;
    return { status: "ready", sourceRevision: "r", total: 101, parents: [], laneCounts: {},
      items: Array.from({ length: offset === 100 ? 1 : 50 }, (_, n) => ({ id: String(offset + n) })),
      nextCursor: offset === 0 ? "second" : offset === 50 ? "third" : null };
  } } as any;
  const previous = useProjectDashboardState.getState().projects;
  useProjectDashboardState.setState({ projects: { p: { loadedCounts: { "board:work:": 100 } } } });
  let current!: ReturnType<typeof useProjectBoard>;
  function Harness() { current = useProjectBoard("p", "work"); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<Harness />));
    expect(calls).toEqual(["first", "second"]);
    expect(current.page?.status === "ready" && current.page.items.length).toBe(100);
    await act(async () => current.loadMore());
    expect(current.page?.status === "ready" && current.page.items.length).toBe(101);
    await act(async () => root.render(null));
    calls.length = 0;
    await act(async () => root.render(<Harness />));
    expect(calls).toEqual(["first", "second", "third"]);
    expect(current.page?.status === "ready" && current.page.items.length).toBe(101);
  } finally {
    await act(async () => root.unmount()); useProjectDashboardState.setState({ projects: previous });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value;
    }
    dom.window.close();
  }
});

test("lane windows start at ten, expand independently and reset on kind change", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const saved = Object.fromEntries(["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, (globalThis as any)[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: string[] = [];
  dom.window.butlerApp = { getProjectDashboardResource: async ({ query }: { query: string }) => {
    calls.push(query);
    const params = new URLSearchParams(query);
    expect(params.get("limit")).toBe("10");
    const lane = params.get("lane");
    const offset = Number(params.get("cursor") ?? 0);
    return { status: "ready", sourceRevision: "r", total: 25, parents: [], laneCounts: {},
      items: Array.from({ length: Math.min(10, 25 - offset) }, (_, n) => ({ id: `${lane}-${offset + n}`, lane })),
      nextCursor: offset + 10 < 25 ? String(offset + 10) : null };
  } } as any;
  let active!: ReturnType<typeof useProjectBoard>;
  let done!: ReturnType<typeof useProjectBoard>;
  function Harness({ kind }: { kind: "work" | "task" }) {
    active = useProjectBoard("p", kind, undefined, "r", "active");
    done = useProjectBoard("p", kind, undefined, "r", "done");
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const count = (board: typeof active) => board.page?.status === "ready" ? board.page.items.length : 0;
  try {
    await act(async () => root.render(<Harness kind="work" />));
    expect(count(active)).toBe(10); expect(count(done)).toBe(10);
    await act(async () => active.loadMore());
    expect(count(active)).toBe(20); expect(count(done)).toBe(10);
    expect(calls).toHaveLength(3);
    await act(async () => root.render(<Harness kind="task" />));
    expect(count(active)).toBe(10); expect(count(done)).toBe(10);
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value;
    }
    dom.window.close();
  }
});

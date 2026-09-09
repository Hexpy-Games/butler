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

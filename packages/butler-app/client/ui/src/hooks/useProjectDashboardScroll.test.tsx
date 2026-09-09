/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { useProjectDashboardScroll } from "./useProjectDashboardScroll.ts";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";

test("dashboard restores per-project/tab position after content grows and yields to user scrolling", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = Object.fromEntries(["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, (globalThis as any)[key]]));
  const observers = new Set<() => void>();
  class Observer {
    constructor(private callback: () => void) {}
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, ResizeObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  const initial = useProjectDashboardState.getState().projects;
  useProjectDashboardState.setState({ projects: { p: { scrollPositions: { overview: 200 } } } });
  let maximum = 50, position = 0;
  let scroller!: HTMLDivElement;
  function Harness({ project = "p", tab = "overview" }: { project?: string; tab?: string }) {
    const attach = useProjectDashboardScroll(project, tab);
    const ref = useCallback((node: HTMLDivElement | null) => {
      if (node) {
        scroller = node;
        Object.defineProperty(node, "scrollTop", { configurable: true,
          get: () => position, set: (value: number) => { position = Math.min(maximum, value); } });
      }
      attach(node);
    }, [attach]);
    return <div ref={ref}><div>Content</div></div>;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<Harness />));
    expect(position).toBe(50);
    maximum = 1000;
    await act(async () => { for (const notify of observers) notify(); });
    expect(position).toBe(200);
    scroller.scrollTop = 330; scroller.dispatchEvent(new dom.window.Event("scroll"));
    await act(async () => root.render(<Harness tab="history" />));
    expect(position).toBe(0);
    await act(async () => root.render(<Harness />));
    expect(position).toBe(330);
    await act(async () => root.render(<Harness project="other" />));
    expect(position).toBe(0);
    maximum = 50;
    await act(async () => root.render(<Harness />));
    expect(position).toBe(50);
    scroller.dispatchEvent(new dom.window.Event("wheel"));
    scroller.scrollTop = 20; scroller.dispatchEvent(new dom.window.Event("scroll"));
    maximum = 1000;
    for (const notify of observers) notify();
    expect(position).toBe(20);
  } finally {
    await act(async () => root.unmount());
    expect(observers.size).toBe(0);
    useProjectDashboardState.setState({ projects: initial });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value;
    }
    dom.window.close();
  }
});

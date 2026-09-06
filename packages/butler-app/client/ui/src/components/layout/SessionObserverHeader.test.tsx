import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import type { SessionView } from "@/app/types.ts";
import { SessionObserverHeader } from "./SessionObserverHeader";

test("Worker observer back restores the parent; close and main-chat navigation clear history", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const before = useButlerStore.getState();
  const globals = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  useButlerStore.setState({ observerSessionId: null, observerTargetTurnId: null, observerHistory: [],
    sessionViews: { steward: { relation: { safe_title: "Parent activity" } } as SessionView,
      worker: { relation: { safe_title: "Juno activity" } } as SessionView } });
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  try {
    await act(async () => {
      useButlerStore.getState().openSessionObserver("steward", "parent-turn");
      root.render(<Dialog open><SessionObserverHeader /></Dialog>);
    });
    expect(container.textContent).toContain("Parent activity");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => useButlerStore.getState().openSessionObserver("worker"));
    expect(container.textContent).toContain("Juno activity");
    expect(useButlerStore.getState().observerHistory).toHaveLength(1);
    await act(async () => useButlerStore.getState().openSessionObserver("worker"));
    expect(useButlerStore.getState().observerHistory).toHaveLength(1);
    const back = container.querySelector("button")!;
    expect(back.getAttribute("aria-label")).toBeTruthy();
    await act(async () => back.click());
    expect(container.textContent).toContain("Parent activity");
    expect(container.querySelector("button")).toBeNull();
    expect(useButlerStore.getState().observerTargetTurnId).toBe("parent-turn");
    expect(useButlerStore.getState().activeChatId).toBe(before.activeChatId);
    await act(async () => {
      useButlerStore.getState().openSessionObserver("worker");
      useButlerStore.getState().closeSessionObserver();
    });
    expect(useButlerStore.getState().observerSessionId).toBeNull();
    expect(useButlerStore.getState().observerHistory).toEqual([]);
    await act(async () => {
      useButlerStore.getState().openSessionObserver("steward");
      useButlerStore.getState().openSessionObserver("worker");
      useButlerStore.getState().setActiveChatId("other-chat");
    });
    expect(useButlerStore.getState().observerHistory).toEqual([]);
    expect(useButlerStore.getState().observerSessionId).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useButlerStore.setState(before);
    globals.forEach((key, i) => { const descriptor = saved[i]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});

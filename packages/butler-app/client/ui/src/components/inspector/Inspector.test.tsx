/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { useButlerStore } from "@/app/store.ts";
import { Inspector, visibleInspectorTab } from "./Inspector.tsx";

const initialState = useButlerStore.getState();
afterEach(() => useButlerStore.setState(initialState, true));

/** Client render: the inspector reads live store state (a server render sees only the initial state). */
async function renderInspector(developerMode: boolean, rightTab: string) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    // App info never answers, so developer mode follows the settings flag.
    fetch: () => new Promise<Response>(() => undefined), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    useButlerStore.setState({
      activeChatId: "session-one",
      view: { kind: "session" },
      rightOpen: true,
      rightTab,
      settings: { ...EMPTY_SETTINGS, diagnostics_enabled: developerMode },
      summary: null,
    });
    await act(async () => root.render(<Inspector />));
    const tabs = Array.from(container.querySelectorAll("aside button"));
    return {
      labels: tabs.map((tab) => tab.textContent),
      active: tabs.find((tab) => tab.getAttribute("aria-current") === "page")?.textContent,
    };
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

test("the default inspector hides the Context and Workers tabs", async () => {
  expect((await renderInspector(false, "summary")).labels).toEqual(["Summary", "Artifacts", "Schedules"]);
});

test("developer mode shows the Context and Workers tabs", async () => {
  expect((await renderInspector(true, "summary")).labels).toEqual([
    "Summary", "Context", "Artifacts", "Schedules", "Workers",
  ]);
});

test("a saved developer tab falls back to Summary outside developer mode", async () => {
  expect((await renderInspector(false, "context")).active).toBe("Summary");
  expect((await renderInspector(false, "workers")).active).toBe("Summary");
  expect((await renderInspector(true, "context")).active).toBe("Context");
  expect(visibleInspectorTab("artifacts", false)).toBe("artifacts");
  expect(visibleInspectorTab("workers", true)).toBe("workers");
});

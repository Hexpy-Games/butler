import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

test("palette exposes loading, empty, failed and retried results without keeping a previous query", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { CommandPalette } = await import("./CommandPalette");
  const { appCopy } = await import("@/app/copy.ts");
  const pending: Array<{ query: string; resolve: (data: unknown) => void; reject: (error: Error) => void }> = [];
  dom.window.butlerApp = { searchCommandPalette: ({ query }: { query: string }) => new Promise((resolve, reject) => {
    pending.push({ query, resolve, reject });
  }) };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const wait = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  try {
    await act(async () => root.render(<CommandPalette onClose={() => {}} />));
    expect(dom.window.document.body.textContent).toContain(appCopy.commandPalette.loading);
    await wait();
    await act(async () => pending[0]!.resolve({ results: [] }));
    expect(dom.window.document.body.textContent).toContain(appCopy.commandPalette.empty);
    const input = dom.window.document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "new query");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect(dom.window.document.body.textContent).toContain(appCopy.commandPalette.loading);
    await wait();
    expect(pending[1]!.query).toBe("new query");
    await act(async () => pending[1]!.reject(new Error("private backend error")));
    expect(dom.window.document.body.textContent).toContain(appCopy.commandPalette.failed);
    expect(dom.window.document.body.textContent).not.toContain("private backend");
    const retry = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === appCopy.feedback.retry)!;
    await act(async () => retry.click());
    await wait();
    await act(async () => pending[2]!.resolve({ results: [{ id: "one", kind: "project", title: "Matched project" }] }));
    expect(dom.window.document.body.textContent).toContain("Matched project");
    expect(dom.window.document.body.textContent).not.toContain(appCopy.commandPalette.failed);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    saved.forEach(([key, descriptor]) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});

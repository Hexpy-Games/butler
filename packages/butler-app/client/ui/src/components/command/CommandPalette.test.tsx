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

test("palette results are a keyboard listbox with highlighted matches and kind icons", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CommandPalette } = await import("./CommandPalette");
  const { Briefcase, Folder, Notebook } = await import("@/butler-ds");
  const results = [
    { id: "p1", kind: "project", title: "Desktop client polish", route: "" },
    { id: "s1", kind: "project_session", title: "Desk review session", route: "" },
    { id: "g1", kind: "group", title: "Design desk", route: "" },
  ];
  dom.window.butlerApp = { searchCommandPalette: () => Promise.resolve({ results }) };
  const selected: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const doc = dom.window.document;
  try {
    await act(async () => root.render(
      <CommandPalette onClose={() => {}} onSelect={(result) => selected.push(result.id)} />,
    ));
    const input = doc.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "desk");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });

    const listbox = doc.querySelector('[role="listbox"]')!;
    expect(listbox).not.toBeNull();
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    const options = [...doc.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(3);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");

    const press = (key: string) => act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
    });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]!.id);
    await press("ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    await press("Enter");
    expect(selected).toEqual(["s1"]);

    expect(options[0]!.querySelector("mark")?.textContent).toBe("Desk");
    expect(options[2]!.querySelector("mark")?.textContent).toBe("desk");
    const iconMarkup = (option: HTMLElement) => option.querySelector("svg")!.outerHTML;
    expect(iconMarkup(options[0]!)).toBe(renderToStaticMarkup(<Briefcase size="md" />));
    expect(iconMarkup(options[1]!)).toBe(renderToStaticMarkup(<Notebook size="md" />));
    expect(iconMarkup(options[2]!)).toBe(renderToStaticMarkup(<Folder size="md" />));
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    saved.forEach(([key, descriptor]) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});

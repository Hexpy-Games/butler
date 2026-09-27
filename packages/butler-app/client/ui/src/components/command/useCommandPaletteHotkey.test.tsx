import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

test("Cmd+K toggles the palette, but not while a Korean IME composition is in progress", async () => {
  const dom = new JSDOM('<div id="root"></div><div contenteditable="true" id="composer"></div>', { url: "http://localhost" });
  Object.defineProperty(dom.window.navigator, "platform", { value: "MacIntel", configurable: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useButlerStore } = await import("@/app/store.ts");
  const { useCommandPaletteHotkey } = await import("./useCommandPaletteHotkey");
  function Probe() {
    useCommandPaletteHotkey();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const composer = dom.window.document.getElementById("composer")!;
  const press = (init: KeyboardEventInit, keyCode?: number) => {
    const event = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (keyCode) Object.defineProperty(event, "keyCode", { value: keyCode });
    composer.dispatchEvent(event);
  };
  try {
    useButlerStore.setState({ commandOpen: false });
    await act(async () => root.render(<Probe />));
    await act(async () => press({ key: "k", metaKey: true }));
    expect(useButlerStore.getState().commandOpen).toBe(true);
    await act(async () => press({ key: "k", metaKey: true }));
    expect(useButlerStore.getState().commandOpen).toBe(false);
    // Korean IME: the keystroke belongs to the composition (isComposing / keyCode 229).
    await act(async () => press({ key: "k", metaKey: true, isComposing: true }));
    await act(async () => press({ key: "Process", metaKey: true }, 229));
    expect(useButlerStore.getState().commandOpen).toBe(false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

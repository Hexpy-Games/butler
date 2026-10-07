/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useAutomationStore } from "@/stores/automationStore.ts";
import { AutomationForm } from "./AutomationForm";

const initialState = useAutomationStore.getState();
const GLOBAL_KEYS = ["window", "document", "navigator", "Element", "HTMLElement", "HTMLButtonElement", "SVGElement", "Node",
  "MutationObserver", "ResizeObserver", "getComputedStyle", "DocumentFragment", "Event", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "FocusEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = GLOBAL_KEYS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
let root: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  useAutomationStore.setState(initialState, true);
  setAppCopyLanguage("en-US");
  GLOBAL_KEYS.forEach((key, index) => {
    const descriptor = savedGlobals[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
  dom?.window.close();
  dom = undefined;
});

async function mount(state: Partial<ReturnType<typeof useAutomationStore.getState>> = {}) {
  dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    SVGElement: dom.window.SVGElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent, PointerEvent: dom.window.MouseEvent, FocusEvent: dom.window.FocusEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root")!;
  root = createRoot(container);
  await act(async () => {
    useAutomationStore.setState({
      isNew: true,
      sessionOptions: [{ id: "chat-a", label: "A" }],
      targetSessionId: "chat-a",
      intervalSeconds: 1800,
      accessMode: "ask_except_reads",
      saveError: null,
      ...state,
    });
    root!.render(<AutomationForm />);
  });
  return container;
}

const trigger = (container: Element) =>
  container.querySelector<HTMLButtonElement>('[data-test-class="automation-access-trigger"]')!;

test("the access field shows the composer's label and icon for the selected mode", async () => {
  setAppCopyLanguage("ko");
  const container = await mount({ accessMode: "full_access" });
  const field = container.querySelector('[data-test-class="automation-access-field"]')!;
  expect(field.querySelector('[data-slot="field-label"]')!.textContent).toBe(appCopy.composer.permission);
  expect(trigger(container).textContent).toBe("전체 권한");
  expect(trigger(container).querySelector("svg")).not.toBeNull();
});

test("only ask first shows the one-line hint that runs wait for approval while away", async () => {
  const container = await mount({ accessMode: "ask_except_reads" });
  const hint = container.querySelector('[data-test-class="automation-access-field"] [data-slot="field-description"]');
  expect(hint?.textContent).toBe(appCopy.automations.accessHint);
  expect(trigger(container).getAttribute("aria-describedby")).toBe(hint!.id);

  await act(async () => useAutomationStore.getState().setAccessMode("read_only"));
  expect(container.querySelector('[data-test-class="automation-access-field"] [data-slot="field-description"]')).toBeNull();
  expect(trigger(container).getAttribute("aria-describedby")).toBeNull();
});

test("the selector lists the shipped modes with descriptions and picking one updates the schedule", async () => {
  setAppCopyLanguage("ko");
  const container = await mount({ accessMode: "ask_except_reads" });
  await act(async () => trigger(container).click());
  const items = [...dom!.window.document.querySelectorAll('[data-slot="option-menu-item"]')];
  expect(items.map((item) => item.querySelector('[data-slot="option-menu-item-label"]')!.textContent))
    .toEqual(["읽기 전용", "모두 확인", "먼저 확인", "전체 권한"]);
  expect(items.map((item) => item.querySelector('[data-slot="option-menu-item-description"]')!.textContent))
    .toEqual([appCopy.permissions.readOnlyDesc, appCopy.permissions.askAlwaysDesc, appCopy.permissions.askFirstDesc, appCopy.permissions.fullAccessDesc]);
  expect(items[2]!.getAttribute("aria-current")).toBe("true");

  await act(async () => (items[0] as HTMLButtonElement).click());
  expect(useAutomationStore.getState().accessMode).toBe("read_only");
  expect(trigger(container).textContent).toBe("읽기 전용");
  expect(dom!.window.document.querySelector('[data-slot="option-menu-item"]')).toBeNull();
});

test("save errors render inline on their own field", async () => {
  const container = await mount({ saveError: { field: "title", message: appCopy.automations.errors.title } });
  const errors = () => [...container.querySelectorAll('[data-slot="field-error"]')].map((node) => node.textContent);
  expect(errors()).toEqual([appCopy.automations.errors.title]);
  expect(container.querySelector("input")!.getAttribute("aria-invalid")).toBe("true");

  await act(async () => useAutomationStore.setState({ saveError: { field: "accessMode", message: appCopy.automations.errors.accessMode } }));
  expect(errors()).toEqual([appCopy.automations.errors.accessMode]);
  const accessError = container.querySelector('[data-test-class="automation-access-field"] [data-slot="field-error"]')!;
  expect(trigger(container).getAttribute("aria-invalid")).toBe("true");
  expect(trigger(container).getAttribute("aria-describedby")).toContain(accessError.id);

  await act(async () => useAutomationStore.setState({ saveError: { field: "form", message: appCopy.automations.errors.invalid } }));
  expect(errors()).toEqual([appCopy.automations.errors.invalid]);
});

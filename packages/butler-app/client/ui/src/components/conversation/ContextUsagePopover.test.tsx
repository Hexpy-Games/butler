/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppModelSummary, UsageMonitorView } from "@/app/types.ts";
import { ComposerContextControl } from "./ComposerContextControl";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { useComposerStore } from "./composerStore";
import { quota, usageContext, usageView } from "./contextUsage.fixtures";
import { resetConversationUsageCache, type UsageLoader } from "./useConversationUsage";

const initialButlerState = useButlerStore.getState();
const initialComposerState = useComposerStore.getState();
const GLOBAL_KEYS = ["window", "document", "navigator", "Element", "HTMLElement", "HTMLButtonElement", "SVGElement", "Node",
  "MutationObserver", "ResizeObserver", "getComputedStyle", "DocumentFragment", "Event", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "FocusEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = GLOBAL_KEYS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
let root: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  // Radix FocusScope dispatches its unmount event on a timer; let it run on jsdom.
  await new Promise((resolve) => setTimeout(resolve, 0));
  useButlerStore.setState(initialButlerState);
  useComposerStore.setState(initialComposerState);
  resetConversationUsageCache();
  setAppCopyLanguage("en-US");
  GLOBAL_KEYS.forEach((key, index) => {
    const descriptor = savedGlobals[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
  dom?.window.close();
  dom = undefined;
});

function mount(): HTMLElement {
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
  return container;
}

function model(fields: Partial<AppModelSummary> = {}): AppModelSummary {
  return {
    provider_id: "openai", provider_label: "OpenAI", model_id: "m", model_ref: "openai/m",
    display_name: "M", status: "available", default_reasoning_effort: "medium",
    reasoning_efforts: ["medium"], token_estimator: "tiktoken", runtime_supported: true, ...fields,
  };
}

function loader(view: UsageMonitorView | Error) {
  const calls: string[] = [];
  const load: UsageLoader = async (sessionId) => {
    calls.push(sessionId);
    if (view instanceof Error) throw view;
    return view;
  };
  return { calls, load };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("ContextUsagePopover", () => {
  test("names the context window once and shows compact used / budget", () => {
    const markup = renderToStaticMarkup(<ContextUsagePopover context={usageContext} mode="local" sessionId="s1" />);
    expect(markup.split(appCopy.interfacePanels.contextWindow).length - 1).toBe(1);
    expect(markup).toContain(appCopy.interfaceTemplates.contextMetric("full", 7));
    expect(markup).toContain("18k / 258k");
    expect(markup).toContain('data-numeric="tabular"');
  });

  test("Korean compact counts", () => {
    setAppCopyLanguage("ko-KR");
    const markup = renderToStaticMarkup(<ContextUsagePopover context={usageContext} mode="local" sessionId="s1" />);
    expect(markup).toContain("1.8만 / 25.8만");
  });

  test("local models show context only, with Details", async () => {
    const container = mount();
    const { calls, load } = loader(usageView());
    let details = 0;
    await act(async () => root!.render(<ContextUsagePopover context={usageContext} mode="local" sessionId="s1" load={load} onDetails={() => { details += 1; }} />));
    expect(container.querySelector('[data-slot="usage-summary-rows"]')).toBeNull();
    expect(calls).toEqual([]);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-test-class="context-usage-details"]')!.click());
    expect(details).toBe(1);
  });

  test("API key: loading skeleton, then tokens and an unpriced cost", async () => {
    const container = mount();
    const { calls, load } = loader(usageView({ reasoning: 1_280 }));
    await act(async () => root!.render(<ContextUsagePopover context={usageContext} mode="api_key" sessionId="s1" load={load} />));
    expect(calls).toEqual(["s1"]);
    await flush();
    const text = container.textContent ?? "";
    for (const label of ["Input", "Cached", "Output", "Reasoning", "Cost", "48.2k", "31.9k", "3.4k", "—"]) expect(text).toContain(label);
    expect(text).not.toContain("est.");
  });

  test("the first render before data is the loading state", () => {
    const markup = renderToStaticMarkup(
      <ContextUsagePopover context={usageContext} mode="api_key" sessionId="s1" load={() => new Promise(() => undefined)} />,
    );
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain('aria-busy="true"');
  });

  test("subscription shows quota windows left", async () => {
    const container = mount();
    const { load } = loader(usageView({ quota: quota() }));
    await act(async () => root!.render(<ContextUsagePopover context={usageContext} mode="subscription" sessionId="s1" load={load} />));
    await flush();
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(3);
    expect(container.textContent).toContain("82% left");
    expect(container.textContent).toContain("5-hour limit");
  });

  test("a failed fetch or a provider without quota is one muted line", async () => {
    const container = mount();
    const failed = loader(new Error("offline"));
    await act(async () => root!.render(<ContextUsagePopover context={usageContext} mode="api_key" sessionId="s1" load={failed.load} />));
    await flush();
    expect(container.querySelector('[data-slot="usage-unavailable"]')!.textContent).toBe("Usage unavailable");
    resetConversationUsageCache();
    const noQuota = loader(usageView());
    await act(async () => root!.render(<ContextUsagePopover context={usageContext} mode="subscription" sessionId="s2" load={noQuota.load} />));
    await flush();
    expect(container.querySelector('[data-slot="usage-unavailable"]')!.textContent).toBe("Usage unavailable");
  });

  test("refetches when the session view's context changes, without timers", async () => {
    const container = mount();
    const { calls, load } = loader(usageView());
    await act(async () => root!.render(<ContextUsagePopover context={usageContext} mode="api_key" sessionId="s1" load={load} />));
    await flush();
    await act(async () => root!.render(
      <ContextUsagePopover context={{ ...usageContext, used_tokens: 20_000, updated_at: "2026-09-28T05:20:00Z" }} mode="api_key" sessionId="s1" load={load} />,
    ));
    await flush();
    expect(calls).toEqual(["s1", "s1"]);
    expect(container.querySelector('[data-slot="usage-summary-rows"]')!.getAttribute("data-state")).toBe("ready");
  });
});

describe("ComposerContextControl", () => {
  async function renderControl(fields: Partial<AppModelSummary> = { auth_type: "api_key" }) {
    const container = mount();
    const { load } = loader(usageView());
    const [opened, setOpened] = [[] as boolean[], (open: boolean) => { opened.push(open); useComposerStore.setState({ contextPopoverOpen: open }); }];
    useComposerStore.setState({
      context: usageContext, models: [model(fields)], activeModel: model(fields),
      contextPopoverOpen: false, setContextPopoverOpen: setOpened,
    });
    await act(async () => root!.render(<ComposerContextControl load={load} />));
    const button = container.querySelector<HTMLButtonElement>('[data-test-class="context-donut-button"]')!;
    return { button, opened };
  }
  const popover = () => dom!.window.document.querySelector('[data-test-class="context-popover"]');
  // React derives onPointerEnter/Leave from pointerover/pointerout.
  const pointer = (element: Element, type: "pointerenter" | "pointerleave") => act(async () => {
    const outside = dom!.window.document.body;
    element.dispatchEvent(type === "pointerenter"
      ? new dom!.window.MouseEvent("pointerover", { bubbles: true, relatedTarget: outside })
      : new dom!.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: outside }));
  });

  test("hover previews and leaving closes it", async () => {
    const { button } = await renderControl();
    await pointer(button, "pointerenter");
    expect(popover()).not.toBeNull();
    await pointer(button, "pointerleave");
    expect(popover()).toBeNull();
  });

  test("click pins the popover: leaving keeps it; a second click closes it", async () => {
    const { button } = await renderControl();
    await pointer(button, "pointerenter");
    await act(async () => button.click());
    await pointer(button, "pointerleave");
    expect(popover()).not.toBeNull();
    expect(popover()!.getAttribute("data-pinned")).toBe("true");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    expect(popover()).toBeNull();
  });

  test("Enter pins it (keyboard click) and Escape closes it", async () => {
    const { button } = await renderControl();
    button.focus();
    await act(async () => { button.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true, detail: 0 })); });
    expect(popover()).not.toBeNull();
    await act(async () => {
      dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  test("Details opens Settings > Usage and closes the popover", async () => {
    let section: string | undefined;
    useButlerStore.setState({ openSettings: (next?: string) => { section = next; } });
    const { button } = await renderControl();
    await act(async () => button.click());
    await flush();
    await act(async () => dom!.window.document.querySelector<HTMLButtonElement>('[data-test-class="context-usage-details"]')!.click());
    expect(section).toBe("usage");
    expect(popover()).toBeNull();
  });

  test("popover is the narrow width", async () => {
    const { button } = await renderControl();
    await act(async () => button.click());
    expect(popover()!.getAttribute("data-popover-width")).toBe("narrow");
  });
});

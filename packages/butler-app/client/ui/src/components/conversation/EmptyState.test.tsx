/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createRef } from "react";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { getAppCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { EmptyState } from "./EmptyState.tsx";
import { useComposerStore } from "./composerStore.ts";

async function renderEmptyState(title: string, run: (container: HTMLElement, sent: string[]) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  Object.assign(dom.window, { ResizeObserver, matchMedia });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment, ResizeObserver, matchMedia,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    // The server briefing never answers, so the fallback suggestions stay.
    fetch: () => new Promise<Response>(() => undefined), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const butlerState = useButlerStore.getState();
  const composerState = useComposerStore.getState();
  Object.assign(globalThis, globals);
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const sent: string[] = [];
  const editor = dom.window.document.createElement("div");
  editor.tabIndex = 0;
  dom.window.document.body.append(editor);
  const textAreaRef = createRef<HTMLElement>() as { current: HTMLElement | null };
  textAreaRef.current = editor;
  try {
    useButlerStore.setState({ settings: { ...EMPTY_SETTINGS, main_screen_theme: "none" }, activeChatId: "draft:chat" });
    useComposerStore.setState({ text: "", contentParts: undefined, textAreaRef, appendDraftText: null, draftSessionId: "draft:chat" });
    await act(async () => root.render(
      <EmptyState
        activeChat={{ title, shortTitle: title, project: "" }}
        isSending={false}
        markTheme="light"
        onSend={(text) => sent.push(text)}
      />,
    ));
    await run(container, sent);
  } finally {
    await act(async () => root.unmount());
    useButlerStore.setState(butlerState, true);
    useComposerStore.setState(composerState, true);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function card(container: HTMLElement, title: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('[role="button"], button'))
    .find((element) => element.textContent?.includes(title));
  if (!match) throw new Error(`Missing suggestion ${title}`);
  return match;
}

test("a template suggestion fills the composer instead of sending", async () => {
  setAppCopyLanguage("en");
  const copy = getAppCopy("en-US").briefing.general.suggestions;
  const template = copy.find((suggestion) => suggestion.template)!;
  const direct = copy.find((suggestion) => !suggestion.template)!;
  await renderEmptyState("New chat", async (container, sent) => {
    await act(async () => card(container, template.title).click());
    expect(sent).toEqual([]);
    expect(useComposerStore.getState().text).toBe(template.text);
    expect(container.ownerDocument.activeElement).toBe(useComposerStore.getState().textAreaRef?.current ?? null);

    await act(async () => card(container, direct.title).click());
    expect(sent).toEqual([direct.text]);
  });
});

test("with the editor mounted, a template is appended there with the caret at the end", async () => {
  setAppCopyLanguage("en");
  const template = getAppCopy("en-US").briefing.general.suggestions.find((suggestion) => suggestion.template)!;
  await renderEmptyState("New chat", async (container, sent) => {
    const appended: string[] = [];
    useComposerStore.setState({ appendDraftText: (text) => void appended.push(text) });
    await act(async () => card(container, template.title).click());
    expect(appended).toEqual([template.text]);
    expect(sent).toEqual([]);
  });
});

test("a template never overwrites a draft the user already started", async () => {
  setAppCopyLanguage("en");
  const template = getAppCopy("en-US").briefing.general.suggestions.find((suggestion) => suggestion.template)!;
  await renderEmptyState("New chat", async (container, sent) => {
    await act(async () => useComposerStore.getState().setText("my own words"));
    await act(async () => card(container, template.title).click());
    expect(useComposerStore.getState().text).toBe("my own words");
    expect(sent).toEqual([]);
  });
});

test("a chat title never switches the empty state to skill suggestions", async () => {
  setAppCopyLanguage("ko");
  await renderEmptyState("스킬 만들기", async (container) => {
    const suggestions = container.querySelector('[data-test-class="new-chat-suggestions"]')?.textContent ?? "";
    expect(suggestions).not.toContain("스킬");
    expect(suggestions).toContain(getAppCopy("ko-KR").briefing.general.suggestions[0]!.title);
  });
  setAppCopyLanguage("en");
});

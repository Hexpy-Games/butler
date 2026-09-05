import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";
import type { ComposerSubmit } from "./hooks/composerEventTypes";

let root: Root | undefined;
let dom: JSDOM | undefined;
let current: ComposerAuthorityDecision | undefined;
let submitCurrent: ComposerSubmit;

async function renderDecision() {
  dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { useButlerStore } = await import("@/app/store.ts");
  const { useComposerStore } = await import("./composerStore");
  const { useComposerDecision } = await import("./hooks/useComposerDecision");
  const { ComposerAuthorityDecisionSurface } = await import("./ComposerAuthorityDecisionSurface");
  const { ComposerTextArea } = await import("./ComposerTextArea");
  const { ComposerDecisionAttachment } = await import("./ComposerDecisionAttachment");
  useButlerStore.setState({ activeChatId: "general", authorityApprovals: {
    sessionId: "general", cards: [{ requestRef: "request-one", category: "command",
      executable: "git", commandCount: 1, reason: "Run one reviewed command",
      scope: { title: "동일한 명령 실행", description: "git · 현재 요청과 동일한 명령·작업 위치에만 적용" },
    }, { requestRef: "request-two", category: "command", executable: "other", commandCount: 1, reason: "Second request" }],
  } });
  useComposerStore.setState({ text: "보존할 일반 대화 초안", textAreaRef: React.createRef<HTMLTextAreaElement>() });
  function Harness() {
    const decisionOwner = useComposerDecision(false);
    current = decisionOwner.authority;
    submitCurrent = decisionOwner.onSubmit;
    if (!current) return <ComposerTextArea />;
    const decision = current;
    return decision.editingInstruction || decision.composingMessage ? <>
      <ComposerDecisionAttachment title={decision.title} label={decision.editingInstruction ? "요청 수정 중" : `허용 대기 ${decision.pendingCount}개`} onShowDecision={decision.onShowDecision} />
      <ComposerTextArea input={decision.editingInstruction ? { value: decision.instruction, onChange: decision.setInstruction, onKeyDown: () => {} } : undefined} />
    </> : <ComposerAuthorityDecisionSurface decision={decision} />;
  }
  const container = dom.window.document.getElementById("root")!;
  await act(async () => { root = createRoot(container); root.render(<Harness />); });
  return { container, store: useButlerStore, composer: useComposerStore };
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined; current = undefined; dom?.window.close(); dom = undefined;
});

test("only the oldest actual request replaces the Composer with ordered decision buttons", async () => {
  const { container, store } = await renderDecision();
  expect(container.textContent).not.toContain("Second request");
  expect([...container.querySelectorAll("button")].slice(2).map((button) => button.textContent))
    .toEqual(["직접 입력", "거절", "이번만 허용", ""]);
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => { store.setState({ authorityApprovals: { sessionId: "different", cards: store.getState().authorityApprovals!.cards } }); });
  expect(container.textContent).not.toContain("이번만 허용");
  expect(container.querySelector("textarea")?.value).toBe("보존할 일반 대화 초안");
});

test("a pending request can be folded away without consuming the normal Composer draft", async () => {
  const { container, composer } = await renderDecision();
  await act(async () => { current!.onComposeMessage(); });
  expect(container.querySelector("textarea")?.value).toBe(composer.getState().text);
  expect(container.textContent).toContain("허용 대기 2개");
  expect(container.textContent).not.toContain("이번만 허용");
  await act(async () => { current!.onShowDecision(); });
  expect(container.textContent).toContain("이번만 허용");
  expect(current?.composingMessage).toBe(false);
});

test("instruction uses the existing textarea, preserves the ordinary draft, and can reopen the decision", async () => {
  const { container, composer } = await renderDecision();
  await act(async () => { current!.onOpenInstruction(); });
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  expect(container.textContent).toContain("요청 수정 중");
  await act(async () => { current!.setInstruction("  다른 위치에 저장해 주세요.\n"); });
  expect(container.querySelector("textarea")?.value).toBe("  다른 위치에 저장해 주세요.\n");
  expect(composer.getState().text).toBe("보존할 일반 대화 초안");
  await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
  expect(container.textContent).toContain("이번만 허용");
  await act(async () => { current!.onOpenInstruction(); });
  expect(container.querySelector("textarea")?.value).toBe("  다른 위치에 저장해 주세요.\n");
});

test("once and conversation allow retain their exact scope and block duplicate submission", async () => {
  const { store } = await renderDecision();
  const calls: unknown[] = [];
  let finish!: (value: boolean) => void;
  store.setState({ allowAuthorityRequest: async (...args) => {
    calls.push(args); return await new Promise<boolean>((resolve) => { finish = resolve; });
  } });
  await act(async () => { current!.onAllowConversation(); current!.onAllow(); });
  expect(calls).toEqual([["request-one", "general", "conversation"]]);
  expect(current?.pending).toBe(true);
  await act(async () => { finish(false); });
  expect(current?.error).toBeDefined();
  await act(async () => { current!.onAllow(); });
  expect(calls.at(-1)).toEqual(["request-one", "general", "once"]);
  await act(async () => { finish(true); });
});

test("Modify sends the complete instruction and does not consume the normal message draft", async () => {
  const { store, composer } = await renderDecision();
  let sent: unknown[] = [];
  store.setState({ modifyAuthorityRequest: async (...args) => { sent = args; return true; } });
  await act(async () => { current!.onOpenInstruction(); current!.setInstruction("  원문 그대로\n"); });
  await act(async () => { current!.onSubmitInstruction({ key: "Enter", preventDefault() {} }); });
  expect(sent).toEqual(["request-one", "  원문 그대로\n", "general"]);
  expect(composer.getState().text).toBe("보존할 일반 대화 초안");
});

test("form and keyboard submissions follow the visible decision instead of consuming the normal draft", async () => {
  const { store, composer } = await renderDecision();
  let normalSubmissions = 0;
  const instructions: string[] = [];
  await act(async () => {
    composer.setState({ submit: () => { normalSubmissions += 1; } });
    store.setState({ modifyAuthorityRequest: async (_ref, text) => { instructions.push(text); return true; } });
  });
  const event = { key: "Enter", preventDefault() {} };
  await act(async () => { submitCurrent(event); });
  expect(normalSubmissions).toBe(0);
  expect(instructions).toEqual([]);
  await act(async () => { current!.onOpenInstruction(); current!.setInstruction("변경 지시"); });
  await act(async () => { submitCurrent(event); });
  expect(instructions).toEqual(["변경 지시"]);
  expect(normalSubmissions).toBe(0);
  await act(async () => { current!.onComposeMessage(); });
  await act(async () => { submitCurrent(event); });
  expect(normalSubmissions).toBe(1);
});

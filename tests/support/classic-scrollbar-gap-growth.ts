import type { Page } from "playwright";

// Test-only access to the actual harness's subscribed store action. No second
// React/store bundle, synthetic DOM messages, or production instrumentation.
export async function growTranscript(page: Page) {
  return page.evaluate(async () => {
    const root = document.querySelector('[data-test-class~="conversation"]')!;
    const key = Object.keys(root).find(key => key.startsWith("__reactFiber$"));
    if (!key) throw new Error("React harness fiber missing");
    let action: ((messages: unknown[]) => void) | undefined;
    for (let fiber = (root as any)[key]; fiber && !action; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        if (typeof hook.memoizedState === "function" && hook.memoizedState.name === "setMessages") action = hook.memoizedState;
      }
    }
    if (!action) throw new Error("Harness setMessages subscription missing");
    const fixture = (window as any).butlerConversationFixture;
    const message = fixture.messages[0];
    const messages = [...fixture.messages];
    for (let i = 1; i <= 24; i++) {
      messages.push({ ...message, id: `frame-message-${i}`, artifacts: [], text: `Transcript message ${i}.\n\n` + "A complete paragraph of conversation content. ".repeat(8) });
      action([...messages]);
      await new Promise<void>(done => requestAnimationFrame(() => done()));
    }
    return { messages: messages.length };
  });
}

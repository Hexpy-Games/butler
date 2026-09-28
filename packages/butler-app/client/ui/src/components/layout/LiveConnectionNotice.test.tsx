/// <reference types="bun" />

import { expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { appCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { LiveConnectionNotice } from "./LiveConnectionNotice";

async function withNotice(
  state: {
    agentNotice: "stopped" | "restarting" | "restart_failed" | null;
    liveConnectionLost: boolean;
  },
  bridge: Record<string, unknown>,
  run: (container: HTMLElement, dom: JSDOM) => Promise<void>,
) {
  const before = useButlerStore.getState();
  const dom = new JSDOM('<div id="root"></div>');
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    DocumentFragment: globalThis.DocumentFragment,
  };
  Object.assign(dom.window, { butlerApp: bridge });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    DocumentFragment: dom.window.DocumentFragment,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => {
      useButlerStore.setState(state);
      root.render(<LiveConnectionNotice />);
    });
    await run(container, dom);
  } finally {
    await act(async () => root.unmount());
    useButlerStore.setState({
      agentNotice: before.agentNotice,
      liveConnectionLost: before.liveConnectionLost,
    });
    Object.assign(globalThis, saved, { IS_REACT_ACT_ENVIRONMENT: false });
    dom.window.close();
  }
}

test("a stopped agent shows a terse stopped state with a start action", async () => {
  const starts: unknown[] = [];
  await withNotice(
    { agentNotice: "stopped", liveConnectionLost: true },
    { startAgent: async () => { starts.push(true); return { state: "running" }; } },
    async (container, dom) => {
      const notice = container.querySelector('[data-test-class~="agent-status-notice"]');
      expect(notice?.getAttribute("role")).toBe("status");
      expect(notice?.textContent).toContain(appCopy.feedback.agentStopped);
      expect(container.textContent).not.toContain(appCopy.feedback.reconnecting);
      const button = [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === appCopy.feedback.agentStart);
      expect(button).toBeDefined();
      await act(async () => {
        button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(starts).toHaveLength(1);
    },
  );
});

test("an external restart shows a terse restarting state with no actions", async () => {
  await withNotice(
    { agentNotice: "restarting", liveConnectionLost: true },
    { startAgent: async () => ({ state: "running" }) },
    async (container) => {
      const notice = container.querySelector('[data-test-class~="agent-status-notice"]');
      expect(notice?.getAttribute("role")).toBe("status");
      expect(notice?.textContent).toBe(appCopy.feedback.agentRestarting);
      expect(container.querySelector("button")).toBeNull();
    },
  );
});

test("a failed external restart shows an error with a retry action", async () => {
  const starts: unknown[] = [];
  await withNotice(
    { agentNotice: "restart_failed", liveConnectionLost: true },
    { startAgent: async () => { starts.push(true); return { state: "running" }; } },
    async (container, dom) => {
      const notice = container.querySelector('[data-test-class~="agent-status-notice"]');
      expect(notice?.textContent).toContain(appCopy.feedback.agentRestartFailed);
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent)).toEqual([appCopy.feedback.retry]);
      await act(async () => {
        buttons[0]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(starts).toHaveLength(1);
    },
  );
});

test("a lost live connection without a stopped agent keeps the quiet reconnect notice", async () => {
  await withNotice(
    { agentNotice: null, liveConnectionLost: true },
    {},
    async (container) => {
      expect(container.querySelector('[data-test-class~="agent-status-notice"]')).toBeNull();
      expect(container.querySelector('[data-test-class~="live-connection-notice"]')?.textContent)
        .toBe(appCopy.feedback.reconnecting);
      expect(container.querySelector("button")).toBeNull();
    },
  );
});

test("stopped-state copy is terse and uses the agent wording in both locales", () => {
  try {
    setAppCopyLanguage("ko");
    expect(appCopy.feedback.agentStopped).toBe("에이전트 중지됨");
    expect(appCopy.feedback.agentRestarting).toBe("재시작 중");
    expect(appCopy.feedback.agentStart).toBe("시작");
    expect(appCopy.feedback.retry).toBe("다시 시도");
    setAppCopyLanguage("en");
    expect(appCopy.feedback.agentStopped).toBe("Agent stopped");
    expect(appCopy.feedback.agentRestarting).toBe("Restarting");
    expect(appCopy.feedback.agentStart).toBe("Start");
    for (const text of [appCopy.feedback.agentRestartFailed, appCopy.feedback.agentStartFailed]) {
      expect(text.split(/\s+/u).length).toBeLessThanOrEqual(5);
    }
  } finally {
    setAppCopyLanguage("en");
  }
});

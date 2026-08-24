/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AuthorityRequestsTransportView,
  SessionView,
  SessionViewBridgeResult,
} from "@/app/types.ts";

const SESSION_A = "sess-approval-alpha";
const SESSION_B = "sess-approval-beta";
const CANARY_REF = "authority-ref-canary0123456789abcdef";
const CANARY_COMMAND = "SECRET-CANARY-COMMAND --private-flag /canary/path";

interface BridgeHarness {
  authorityCalls: number;
  authorityPayload: (input?: unknown) => unknown | Promise<unknown>;
  allowCalls: Array<{ requestRef?: string; sessionId?: string }>;
  allowPayload: () => unknown | Promise<unknown>;
  denyCalls: Array<{ requestRef?: string; sessionId?: string }>;
  denyPayload: () => unknown | Promise<unknown>;
  modifyCalls: Array<{
    alternative?: string;
    requestRef?: string;
    sessionId?: string;
  }>;
  modifyPayload: () => unknown | Promise<unknown>;
  sessionViewPayload: (() => SessionViewBridgeResult | SessionView) | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const bridgeHarness: BridgeHarness = {
  authorityCalls: 0,
  authorityPayload: () => ({ requests: [] }),
  allowCalls: [],
  allowPayload: () => ({
    request_ref: CANARY_REF,
    decision: "allowed",
    scheduled: true,
  }),
  denyCalls: [],
  denyPayload: () => ({
    request_ref: CANARY_REF,
    decision: "denied",
    scheduled: true,
  }),
  modifyCalls: [],
  modifyPayload: () => ({
    request_ref: CANARY_REF,
    decision: "modified",
    scheduled: true,
  }),
  sessionViewPayload: null,
};

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  if (!resolve || !reject) {
    throw new Error("Deferred resolver was not initialized.");
  }
  return { promise, resolve, reject };
}

function approvalFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    request_ref: CANARY_REF,
    category: "command",
    reason: "Run one reviewed command",
    executable: "alpha-runner",
    command_count: 1,
    normalized_target: "CANARY-TARGET",
    raw_command: CANARY_COMMAND,
    arguments: [CANARY_COMMAND],
    source_session_id: "CANARY-SOURCE",
    owner_session_id: SESSION_A,
    ...overrides,
  };
}

function transportView(
  requests: unknown[],
  sessionId = SESSION_A,
): AuthorityRequestsTransportView {
  return { session_id: sessionId, requests };
}

function requestedSessionId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const sessionId = Reflect.get(input, "sessionId");
  return typeof sessionId === "string" ? sessionId : undefined;
}

function sessionViewFixture(sessionId: string): SessionView {
  const now = new Date().toISOString();
  return {
    protocol_version: "butler.app.v1",
    session_id: sessionId,
    kind: "chat",
    status: "idle",
    active_turn: null,
    latest_turn: null,
    messages: [],
    message_window: { next_cursor: 0, complete: true },
    workers: [],
    work_streams: [],
    artifacts: [],
    context: null,
    branch: null,
    automations: [],
    errors: [],
    cursors: { messages: 0, events: 0 },
    generated_at: now,
    updated_at: now,
  };
}

function installDom(): { dom: JSDOM; container: HTMLElement } {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.butlerApp = {
    getAuthorityRequests: async (input) => {
      bridgeHarness.authorityCalls += 1;
      return structuredClone(await bridgeHarness.authorityPayload(input));
    },
    allowAuthorityRequest: async (input) => {
      bridgeHarness.allowCalls.push(structuredClone(input ?? {}));
      return structuredClone(await bridgeHarness.allowPayload());
    },
    denyAuthorityRequest: async (input) => {
      bridgeHarness.denyCalls.push(structuredClone(input ?? {}));
      return structuredClone(await bridgeHarness.denyPayload());
    },
    modifyAuthorityRequest: async (input) => {
      bridgeHarness.modifyCalls.push(structuredClone(input ?? {}));
      return structuredClone(await bridgeHarness.modifyPayload());
    },
    getSessionView: async () => {
      if (!bridgeHarness.sessionViewPayload) {
        throw new Error("session view bridge not configured");
      }
      return bridgeHarness.sessionViewPayload();
    },
    readCachedMessages: async () => null,
    writeCachedMessages: async () => ({ ok: true }),
  };
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  return { dom, container };
}

async function renderStack(
  dom: JSDOM,
  container: HTMLElement,
): Promise<Root> {
  const { createRoot } = await import("react-dom/client");
  const { AuthorityApprovalStack } = await import("./AuthorityApprovalStack");
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<AuthorityApprovalStack />);
    await Promise.resolve();
  });
  void dom;
  if (!root) throw new Error("Missing rendered root.");
  return root;
}

async function settleTurns(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function settleMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function flushTurns(times = 4): Promise<void> {
  await act(async () => {
    await settleTurns(times);
  });
}

async function loadStore() {
  return await import("@/app/store.ts");
}

afterEach(() => {
  bridgeHarness.authorityCalls = 0;
  bridgeHarness.authorityPayload = () => ({ requests: [] });
  bridgeHarness.allowCalls = [];
  bridgeHarness.allowPayload = () => ({
    request_ref: CANARY_REF,
    decision: "allowed",
    scheduled: true,
  });
  bridgeHarness.denyCalls = [];
  bridgeHarness.denyPayload = () => ({
    request_ref: CANARY_REF,
    decision: "denied",
    scheduled: true,
  });
  bridgeHarness.modifyCalls = [];
  bridgeHarness.modifyPayload = () => ({
    request_ref: CANARY_REF,
    decision: "modified",
    scheduled: true,
  });
  bridgeHarness.sessionViewPayload = null;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

describe("AuthorityApprovalStack", () => {
  test("renders the durable projection in unchanged backend order", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-oldest",
          executable: "alpha-runner",
          reason: "Oldest pending command.",
        }),
        approvalFixture({
          request_ref: "authority-ref-newer",
          executable: "beta-runner",
          reason: "Newer pending command.",
          command_count: 3,
        }),
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    const refreshed = await act(async () =>
      useButlerStore.getState().refreshAuthorityApprovals(SESSION_A),
    );
    expect(refreshed).toBe(true);
    await flushTurns();
    const root = await renderStack(dom, container);
    const text = container.textContent ?? "";
    expect(text).toContain("Command awaiting approval");
    expect(text).toContain("Oldest pending command.");
    expect(text.indexOf("alpha-runner")).toBeGreaterThan(-1);
    expect(text.indexOf("beta-runner")).toBeGreaterThan(
      text.indexOf("alpha-runner"),
    );
    await act(async () => root.unmount());
  });

  test("empty projection renders nothing", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () => transportView([]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    expect(useButlerStore.getState().authorityApprovals?.cards).toEqual([]);
    const root = await renderStack(dom, container);
    expect(container.textContent ?? "").not.toContain(
      "Command awaiting approval",
    );
    expect(container.querySelector("[class]")).toBeNull();
    await act(async () => root.unmount());
  });

  test("only bounded display fields reach the DOM", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          executable: "gamma-runner",
          reason: "Bounded reason text.",
          command_count: 2,
        }),
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    const root = await renderStack(dom, container);
    const html = container.innerHTML;
    expect(html).toContain("Bounded reason text.");
    expect(html).toContain("gamma-runner");
    expect(html).not.toContain(CANARY_REF);
    expect(html).not.toContain(CANARY_COMMAND);
    expect(html).not.toContain("CANARY-TARGET");
    expect(html).not.toContain("normalized_target");
    expect(html).not.toContain("request_ref");
    const storedRef =
      useButlerStore.getState().authorityApprovals?.cards[0]?.requestRef;
    expect(storedRef).toBe(CANARY_REF);
    await act(async () => root.unmount());
  });

  test("malformed projection entries fail closed", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-good",
          executable: "good-runner",
          reason: "Valid card.",
        }),
        approvalFixture({
          request_ref: "authority-ref-malformed",
          executable: "",
          reason: "Malformed card.",
        }),
        { broken: true },
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    const cards = useButlerStore.getState().authorityApprovals?.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.executable).toBe("good-runner");
    const root = await renderStack(dom, container);
    expect(container.textContent).toContain("Valid card.");
    expect(container.textContent).not.toContain("Malformed card.");
    await act(async () => root.unmount());
  });

  test("mismatched or malformed transport session identity fails closed", async () => {
    installDom();
    const { useButlerStore } = await loadStore();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-session-bound",
          executable: "session-bound-runner",
          reason: "Session-bound pending command.",
        }),
      ]);
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    expect(
      await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A),
    ).toBe(true);
    const acceptedProjection = useButlerStore.getState().authorityApprovals;

    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-wrong-session",
          executable: "wrong-session-runner",
          reason: "Wrong-session pending command.",
        }),
      ], SESSION_B);
    expect(
      await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A),
    ).toBe(false);
    expect(useButlerStore.getState().authorityApprovals).toBe(
      acceptedProjection,
    );

    bridgeHarness.authorityPayload = () => ({ requests: [] });
    expect(
      await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A),
    ).toBe(false);
    expect(useButlerStore.getState().authorityApprovals).toBe(
      acceptedProjection,
    );
  });

  test("remount refetches the backend projection without local persistence", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-remount",
          executable: "delta-runner",
          reason: "Durable pending command.",
        }),
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await flushTurns();
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    const firstRoot = await renderStack(dom, container);
    expect(container.textContent).toContain("Durable pending command.");
    await act(async () => firstRoot.unmount());
    act(() => {
      useButlerStore.setState({ authorityApprovals: null });
    });
    expect(container.textContent).not.toContain("Durable pending command.");

    const callsBefore = bridgeHarness.authorityCalls;
    const secondRoot = await renderStack(dom, container);
    expect(container.textContent).not.toContain("Durable pending command.");
    await act(async () => {
      await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
      await settleTurns();
    });
    expect(bridgeHarness.authorityCalls).toBe(callsBefore + 1);
    expect(container.textContent).toContain("Durable pending command.");
    await act(async () => secondRoot.unmount());

    for (const storage of [
      dom.window.localStorage,
      dom.window.sessionStorage,
    ]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? "";
        expect(key.includes("authorit")).toBe(false);
        expect((storage.getItem(key) ?? "").includes("delta-runner")).toBe(
          false,
        );
      }
    }
  });

  test("projection whose stored session id mismatches the active chat stays hidden", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-hidden",
          executable: "hidden-runner",
          reason: "Other session card.",
        }),
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    const root = await renderStack(dom, container);
    expect(container.textContent).toContain("Other session card.");
    bridgeHarness.authorityPayload = (input) =>
      transportView([], requestedSessionId(input) ?? SESSION_A);
    await act(async () => {
      useButlerStore.setState({ activeChatId: SESSION_B });
      await settleTurns();
    });
    expect(
      useButlerStore.getState().authorityApprovals?.sessionId,
    ).toBe(SESSION_B);
    expect(container.textContent).not.toContain("Other session card.");
    expect(container.textContent).not.toContain("hidden-runner");
    await act(async () => root.unmount());
  });

  test("session navigation hydration fetches the projection through the store subscription", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-hydration",
          executable: "epsilon-runner",
          reason: "Hydrated durable card.",
        }),
      ]);
    const { useButlerStore } = await loadStore();
    const root = await renderStack(dom, container);
    await act(async () => {
      useButlerStore.setState({ activeChatId: SESSION_A });
      await settleTurns();
    });
    expect(bridgeHarness.authorityCalls).toBe(1);
    expect(container.textContent).toContain("Hydrated durable card.");
    await act(async () => root.unmount());
  });

  test("transient authority failure preserves the displayed projection and the canonical session refresh", async () => {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-durable",
          executable: "zeta-runner",
          reason: "Survives transient failure.",
        }),
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await flushTurns();
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    const root = await renderStack(dom, container);
    expect(container.textContent).toContain("Survives transient failure.");

    bridgeHarness.authorityPayload = () => {
      throw new Error("authority endpoint temporarily unavailable");
    };
    const failed = await act(async () =>
      useButlerStore.getState().refreshAuthorityApprovals(SESSION_A),
    );
    expect(failed).toBe(false);
    expect(useButlerStore.getState().authorityApprovals?.sessionId).toBe(
      SESSION_A,
    );
    expect(container.textContent).toContain("Survives transient failure.");

    bridgeHarness.sessionViewPayload = () => sessionViewFixture(SESSION_A);
    const refreshed = await act(async () =>
      useButlerStore.getState().refreshSessionView(SESSION_A),
    );
    expect(refreshed).toBe(true);
    expect(useButlerStore.getState().sessionView?.session_id).toBe(SESSION_A);

    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: "authority-ref-converged",
          executable: "eta-runner",
          reason: "Converged via session refresh.",
        }),
      ]);
    const callsBefore = bridgeHarness.authorityCalls;
    const converged = await act(async () => {
      const result = await useButlerStore.getState().refreshSessionView(
        SESSION_A,
      );
      await settleTurns();
      return result;
    });
    expect(converged).toBe(true);
    expect(bridgeHarness.authorityCalls).toBeGreaterThan(callsBefore);
    expect(container.textContent).toContain("Converged via session refresh.");
    await act(async () => root.unmount());
  });

  test("older same-session refresh cannot resurrect a card cleared by a newer response", async () => {
    const { dom, container } = installDom();
    const { useButlerStore } = await loadStore();
    bridgeHarness.authorityPayload = () => transportView([]);
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    act(() => {
      useButlerStore.setState({
        authorityApprovals: {
          sessionId: SESSION_A,
          cards: [
            {
              requestRef: "authority-ref-stale",
              category: "command",
              reason: "Stale pending command.",
              executable: "stale-runner",
              commandCount: 1,
            },
          ],
        },
      });
    });
    const root = await renderStack(dom, container);
    expect(container.textContent).toContain("Stale pending command.");

    const older = deferred<AuthorityRequestsTransportView>();
    const newer = deferred<AuthorityRequestsTransportView>();
    let requestIndex = 0;
    bridgeHarness.authorityPayload = () => {
      requestIndex += 1;
      if (requestIndex === 1) return older.promise;
      if (requestIndex === 2) return newer.promise;
      throw new Error("Unexpected authority refresh.");
    };
    const olderRefresh = useButlerStore
      .getState()
      .refreshAuthorityApprovals(SESSION_A);
    const newerRefresh = useButlerStore
      .getState()
      .refreshAuthorityApprovals(SESSION_A);
    expect(requestIndex).toBe(2);

    const newerResult = await act(async () => {
      newer.resolve(transportView([]));
      return await newerRefresh;
    });
    expect(newerResult).toBe(true);
    expect(useButlerStore.getState().authorityApprovals?.cards).toEqual([]);
    expect(container.textContent).not.toContain("Stale pending command.");

    const olderResult = await act(async () => {
      older.resolve(
        transportView([
          approvalFixture({
            request_ref: "authority-ref-stale",
            executable: "stale-runner",
            reason: "Stale pending command.",
          }),
        ]),
      );
      return await olderRefresh;
    });
    expect(olderResult).toBe(false);
    expect(useButlerStore.getState().authorityApprovals?.cards).toEqual([]);
    expect(container.textContent).not.toContain("Stale pending command.");
    await act(async () => root.unmount());
  });

  const ALLOW_REF = "authority-ref-allow-0123456789abcdef";
  const SECOND_ALLOW_REF = "authority-ref-second-0123456789abcdef";
  const PRIVATE_ALLOW_VALUE = "PRIVATE-ALLOW-VALUE-/secret/path";

  async function renderAllowScene() {
    const { dom, container } = installDom();
    bridgeHarness.authorityPayload = () =>
      transportView([
        approvalFixture({
          request_ref: ALLOW_REF,
          executable: "alpha-runner",
          reason: "Primary pending command.",
          raw_command: PRIVATE_ALLOW_VALUE,
        }),
        approvalFixture({
          request_ref: SECOND_ALLOW_REF,
          executable: "beta-runner",
          reason: "Secondary pending command.",
          raw_command: PRIVATE_ALLOW_VALUE,
        }),
      ]);
    const { useButlerStore } = await loadStore();
    act(() => {
      useButlerStore.setState({ activeChatId: SESSION_A });
    });
    await useButlerStore.getState().refreshAuthorityApprovals(SESSION_A);
    return {
      container,
      root: await renderStack(dom, container),
      store: useButlerStore,
    };
  }

  function allowButtons(container: HTMLElement): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Allow once",
    );
  }

  function buttonsWithLabel(
    container: HTMLElement,
    label: string,
  ): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === label,
    );
  }

  async function changeTextarea(
    textarea: HTMLTextAreaElement,
    value: string,
  ): Promise<void> {
    const view = textarea.ownerDocument.defaultView;
    const setter = view
      ? Object.getOwnPropertyDescriptor(
          view.HTMLTextAreaElement.prototype,
          "value",
        )?.set
      : undefined;
    if (!setter || !view) throw new Error("Missing textarea value setter.");
    await act(async () => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new view.Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  test("a delayed Allow refresh for another session cannot invalidate the active session projection", async () => {
    const allowDecision = deferred<unknown>();
    bridgeHarness.allowPayload = () => allowDecision.promise;
    const scene = await renderAllowScene();
    await click(allowButtons(scene.container)[0]!);

    const sessionARefresh = deferred<AuthorityRequestsTransportView>();
    const sessionBRefresh = deferred<AuthorityRequestsTransportView>();
    const requestedSessions: string[] = [];
    bridgeHarness.authorityPayload = (input) => {
      const sessionId = requestedSessionId(input);
      if (!sessionId) throw new Error("Missing authority projection session.");
      requestedSessions.push(sessionId);
      if (sessionId === SESSION_A) return sessionARefresh.promise;
      if (sessionId === SESSION_B) return sessionBRefresh.promise;
      throw new Error(`Unexpected authority projection session: ${sessionId}`);
    };

    await act(async () => {
      scene.store.setState({ activeChatId: SESSION_B });
      await settleMicrotasks();
    });
    expect(requestedSessions).toEqual([SESSION_B]);

    await act(async () => {
      allowDecision.resolve({
        request_ref: ALLOW_REF,
        decision: "allowed",
        scheduled: true,
      });
      await settleMicrotasks();
    });
    expect(requestedSessions).toEqual([SESSION_B, SESSION_A]);

    await act(async () => {
      sessionARefresh.resolve({ session_id: SESSION_A, requests: [] });
      await settleMicrotasks();
    });
    expect(scene.store.getState().activeChatId).toBe(SESSION_B);

    await act(async () => {
      sessionBRefresh.resolve({
        session_id: SESSION_B,
        requests: [
          approvalFixture({
            request_ref: "authority-ref-session-b",
            owner_session_id: SESSION_B,
            executable: "session-b-runner",
            reason: "Active session pending command.",
          }),
        ],
      });
      await settleMicrotasks();
    });
    expect(scene.store.getState().authorityApprovals).toEqual({
      sessionId: SESSION_B,
      cards: [
        {
          requestRef: "authority-ref-session-b",
          category: "command",
          reason: "Active session pending command.",
          executable: "session-b-runner",
          commandCount: 1,
        },
      ],
    });
    expect(scene.container.textContent).toContain(
      "Active session pending command.",
    );
    expect(scene.container.textContent).not.toContain("Primary pending command.");
    await act(async () => scene.root.unmount());
  });

  test("one-time Allow uses the narrow bridge once, disables only its card, and removes only after GET convergence", async () => {
    const pending = deferred<unknown>();
    bridgeHarness.allowPayload = () => pending.promise;
    const scene = await renderAllowScene();
    const buttons = allowButtons(scene.container);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.type).toBe("button");
      expect(button.dataset.slot).toBe("button");
      expect(button.dataset.variant).toBe("default");
    }
    const composerCanary = [{
      id: "composer-canary",
      text: "Composer draft and attachment canary",
      attachments: [{ file_id: "attachment-canary" }],
    }];
    act(() => {
      scene.store.setState({ messages: composerCanary as never });
    });
    const messagesBefore = scene.store.getState().messages;
    const sendBefore = scene.store.getState().sendMessage;
    const queueBefore = scene.store.getState().queueMessage;

    await click(buttons[0]!);
    await click(buttons[0]!);
    expect(bridgeHarness.allowCalls).toEqual([
      { requestRef: ALLOW_REF, sessionId: SESSION_A },
    ]);
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(false);
    expect(scene.container.textContent).toContain("Primary pending command.");
    expect(scene.container.textContent).toContain("Secondary pending command.");
    expect(document.body.innerHTML).not.toContain(ALLOW_REF);
    expect(document.body.innerHTML).not.toContain(PRIVATE_ALLOW_VALUE);

    const readsBeforeDecision = bridgeHarness.authorityCalls;
    bridgeHarness.authorityPayload = () => transportView([]);
    await act(async () => {
      pending.resolve({
        request_ref: ALLOW_REF,
        decision: "allowed",
        scheduled: false,
      });
      await settleTurns();
    });
    expect(bridgeHarness.authorityCalls).toBe(readsBeforeDecision + 1);
    expect(scene.store.getState().authorityApprovals?.cards).toEqual([]);
    expect(scene.container.textContent).not.toContain("Primary pending command.");
    expect(scene.store.getState().messages).toBe(messagesBefore);
    expect(scene.store.getState().sendMessage).toBe(sendBefore);
    expect(scene.store.getState().queueMessage).toBe(queueBefore);
    expect(scene.store.getState().isSending).toBe(false);
    expect(document.body.innerHTML).not.toContain(ALLOW_REF);
    expect(document.body.innerHTML).not.toContain(PRIVATE_ALLOW_VALUE);
    const { getAppCopy } = await import("@/app/copy.ts");
    expect(getAppCopy("ko-KR").composer.approval.allowOnce).toBe("이번만 허용");
    expect(getAppCopy("ko-KR").composer.approval.decisionFailed).toBe(
      "승인 상태를 확인하지 못했습니다. 요청을 계속 표시합니다.",
    );
    await act(async () => scene.root.unmount());
  });

  test("POST and projection failures preserve the card with only fixed safe error copy", async () => {
    const firstDecision = deferred<unknown>();
    bridgeHarness.allowPayload = () => firstDecision.promise;
    const scene = await renderAllowScene();
    await click(allowButtons(scene.container)[0]!);
    await act(async () => {
      firstDecision.reject(new Error(`${ALLOW_REF} ${PRIVATE_ALLOW_VALUE}`));
      await settleTurns();
    });
    const safeError =
      "Could not confirm the approval. The request remains visible.";
    expect(scene.container.textContent).toContain("Primary pending command.");
    expect(scene.container.textContent).toContain(safeError);
    expect(scene.container.innerHTML).not.toContain(ALLOW_REF);
    expect(scene.container.innerHTML).not.toContain(PRIVATE_ALLOW_VALUE);
    expect(allowButtons(scene.container)[0]!.disabled).toBe(false);

    bridgeHarness.allowPayload = () => ({
      request_ref: ALLOW_REF,
      decision: "allowed",
      scheduled: true,
    });
    bridgeHarness.authorityPayload = () => {
      throw new Error(PRIVATE_ALLOW_VALUE);
    };
    await click(allowButtons(scene.container)[0]!);
    await flushTurns();
    expect(bridgeHarness.allowCalls).toHaveLength(2);
    expect(scene.container.textContent).toContain("Primary pending command.");
    expect(scene.container.textContent).toContain(safeError);
    expect(scene.container.innerHTML).not.toContain(ALLOW_REF);
    expect(scene.container.innerHTML).not.toContain(PRIVATE_ALLOW_VALUE);
    await act(async () => scene.root.unmount());
  });

  test("mismatched, non-Allow, and non-boolean decision responses fail closed without projection reads", async () => {
    const responses = [
      { request_ref: SECOND_ALLOW_REF, decision: "allowed", scheduled: true },
      { request_ref: ALLOW_REF, decision: "denied", scheduled: true },
      { request_ref: ALLOW_REF, decision: "allowed", scheduled: 1 },
    ];
    bridgeHarness.allowPayload = () => responses.shift();
    const scene = await renderAllowScene();
    const readsBefore = bridgeHarness.authorityCalls;
    for (let index = 0; index < 3; index += 1) {
      await click(allowButtons(scene.container)[0]!);
      await flushTurns();
      expect(scene.container.textContent).toContain(
        "Could not confirm the approval. The request remains visible.",
      );
      expect(allowButtons(scene.container)[0]!.disabled).toBe(false);
    }
    expect(bridgeHarness.allowCalls).toHaveLength(3);
    expect(bridgeHarness.authorityCalls).toBe(readsBefore);
    expect(scene.store.getState().authorityApprovals?.cards).toHaveLength(2);
    await act(async () => scene.root.unmount());
  });

  test("Deny submits once, fences only its card, and removes only after GET convergence", async () => {
    const pending = deferred<unknown>();
    bridgeHarness.denyPayload = () => pending.promise;
    const scene = await renderAllowScene();
    const messagesBefore = scene.store.getState().messages;
    const denyButtons = buttonsWithLabel(scene.container, "Deny");

    await click(denyButtons[0]!);
    await click(denyButtons[0]!);
    expect(bridgeHarness.denyCalls).toEqual([
      { requestRef: ALLOW_REF, sessionId: SESSION_A },
    ]);
    expect(denyButtons[0]!.disabled).toBe(true);
    expect(denyButtons[1]!.disabled).toBe(false);
    expect(scene.container.textContent).toContain("Primary pending command.");
    expect(scene.container.textContent).toContain("Secondary pending command.");

    bridgeHarness.authorityPayload = () => transportView([]);
    await act(async () => {
      pending.resolve({
        request_ref: ALLOW_REF,
        decision: "denied",
        scheduled: true,
      });
      await settleTurns();
    });
    expect(scene.store.getState().authorityApprovals?.cards).toEqual([]);
    expect(scene.store.getState().messages).toBe(messagesBefore);
    expect(scene.store.getState().isSending).toBe(false);
    await act(async () => scene.root.unmount());
  });

  test("Modify sends one trimmed private alternative and clears it before durable convergence", async () => {
    const privateAlternative = "PRIVATE-MODIFY-/secret/path use another method";
    const pending = deferred<unknown>();
    bridgeHarness.modifyPayload = () => pending.promise;
    const scene = await renderAllowScene();

    await click(
      buttonsWithLabel(scene.container, "Modify or suggest another approach")[0]!,
    );
    const textarea = scene.container.querySelector("textarea");
    if (!(textarea instanceof window.HTMLTextAreaElement)) {
      throw new Error("Missing private Modify textarea.");
    }
    await changeTextarea(textarea, `  ${privateAlternative}  `);
    expect(textarea.value).toContain(privateAlternative);
    const submit = buttonsWithLabel(scene.container, "Submit suggestion")[0]!;
    expect(submit.disabled).toBe(false);
    await click(submit);
    await click(submit);

    expect(bridgeHarness.modifyCalls).toEqual([
      {
        alternative: privateAlternative,
        requestRef: ALLOW_REF,
        sessionId: SESSION_A,
      },
    ]);
    expect(scene.container.querySelector("textarea")).toBeNull();
    expect(scene.container.innerHTML).not.toContain(privateAlternative);
    expect(JSON.stringify(scene.store.getState().authorityApprovals)).not.toContain(
      privateAlternative,
    );
    expect(scene.container.textContent).toContain("Primary pending command.");
    expect(buttonsWithLabel(scene.container, "Deny")[1]!.disabled).toBe(false);

    bridgeHarness.authorityPayload = () => transportView([]);
    await act(async () => {
      pending.resolve({
        request_ref: ALLOW_REF,
        decision: "modified",
        scheduled: false,
      });
      await settleTurns();
    });
    expect(scene.store.getState().authorityApprovals?.cards).toEqual([]);
    expect(document.body.innerHTML).not.toContain(privateAlternative);
    await act(async () => scene.root.unmount());
  });

  test("Modify rejects blank or oversized text and retries with fixed safe failure copy", async () => {
    const firstPrivate = "PRIVATE-FIRST-MODIFY";
    const retryPrivate = "PRIVATE-RETRY-MODIFY";
    const scene = await renderAllowScene();
    const openModify = () => click(
      buttonsWithLabel(scene.container, "Modify or suggest another approach")[0]!,
    );
    await openModify();
    let textarea = scene.container.querySelector("textarea");
    if (!(textarea instanceof window.HTMLTextAreaElement)) {
      throw new Error("Missing Modify textarea.");
    }

    await changeTextarea(textarea, "   ");
    expect(buttonsWithLabel(scene.container, "Submit suggestion")[0]!.disabled).toBe(
      true,
    );
    await changeTextarea(textarea, "한".repeat(5_500));
    expect(scene.container.textContent).toContain(
      "The suggestion must be non-empty text no larger than 16 KB.",
    );
    expect(buttonsWithLabel(scene.container, "Submit suggestion")[0]!.disabled).toBe(
      true,
    );
    expect(bridgeHarness.modifyCalls).toHaveLength(0);

    bridgeHarness.modifyPayload = () => {
      throw new Error(`${firstPrivate} /private/failure/path`);
    };
    await changeTextarea(textarea, firstPrivate);
    await click(buttonsWithLabel(scene.container, "Submit suggestion")[0]!);
    await flushTurns();
    expect(scene.container.querySelector("textarea")).toBeNull();
    expect(scene.container.textContent).toContain(
      "Could not confirm the approval. The request remains visible.",
    );
    expect(scene.container.innerHTML).not.toContain(firstPrivate);

    bridgeHarness.modifyPayload = () => ({
      request_ref: ALLOW_REF,
      decision: "modified",
      scheduled: true,
    });
    bridgeHarness.authorityPayload = () => transportView([]);
    await openModify();
    textarea = scene.container.querySelector("textarea");
    if (!(textarea instanceof window.HTMLTextAreaElement)) {
      throw new Error("Missing retry Modify textarea.");
    }
    await changeTextarea(textarea, retryPrivate);
    await click(buttonsWithLabel(scene.container, "Submit suggestion")[0]!);
    await flushTurns();
    expect(bridgeHarness.modifyCalls).toEqual([
      {
        alternative: firstPrivate,
        requestRef: ALLOW_REF,
        sessionId: SESSION_A,
      },
      {
        alternative: retryPrivate,
        requestRef: ALLOW_REF,
        sessionId: SESSION_A,
      },
    ]);
    expect(scene.store.getState().authorityApprovals?.cards).toEqual([]);
    expect(document.body.innerHTML).not.toContain(firstPrivate);
    expect(document.body.innerHTML).not.toContain(retryPrivate);
    await act(async () => scene.root.unmount());
  });

  test("Deny and Modify reject mismatched durable responses without projection reads", async () => {
    const scene = await renderAllowScene();
    const readsBefore = bridgeHarness.authorityCalls;
    bridgeHarness.denyPayload = () => ({
      request_ref: ALLOW_REF,
      decision: "allowed",
      scheduled: true,
    });
    await click(buttonsWithLabel(scene.container, "Deny")[0]!);
    await flushTurns();
    expect(bridgeHarness.authorityCalls).toBe(readsBefore);
    expect(scene.store.getState().authorityApprovals?.cards).toHaveLength(2);

    bridgeHarness.modifyPayload = () => ({
      request_ref: SECOND_ALLOW_REF,
      decision: "modified",
      scheduled: true,
    });
    await click(
      buttonsWithLabel(scene.container, "Modify or suggest another approach")[0]!,
    );
    const textarea = scene.container.querySelector("textarea");
    if (!(textarea instanceof window.HTMLTextAreaElement)) {
      throw new Error("Missing Modify textarea.");
    }
    await changeTextarea(textarea, "Safe replacement plan");
    await click(buttonsWithLabel(scene.container, "Submit suggestion")[0]!);
    await flushTurns();
    expect(bridgeHarness.authorityCalls).toBe(readsBefore);
    expect(scene.store.getState().authorityApprovals?.cards).toHaveLength(2);
    expect(scene.container.textContent).toContain(
      "Could not confirm the approval. The request remains visible.",
    );
    await act(async () => scene.root.unmount());
  });
});

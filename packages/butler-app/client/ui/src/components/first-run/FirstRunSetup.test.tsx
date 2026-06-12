/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createInitialFirstRunState,
  type FirstRunState,
} from "@/app/firstRunSetup.ts";
import { FirstRunSetup } from "./FirstRunSetup";

interface RenderedFirstRun {
  calls: string[];
  container: HTMLElement;
  completedStates: FirstRunState[];
  root: Root;
  setupModes: string[];
}

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
});

test("first-run setup renders the minimal Electron setup order", async () => {
  const rendered = await renderFirstRun(createInitialFirstRunState("ko"));

  expect(rendered.container.textContent).toContain("언어 선택");
  expect(rendered.container.textContent).not.toContain("gateway");
  expect(rendered.container.textContent).not.toContain("persona");

  await clickButton(rendered.container, "계속");
  expect(rendered.calls).toContain("updateSettings");
  expect(rendered.container.textContent).toContain("안전고지");

  await clickButton(rendered.container, "동의");
  expect(rendered.container.textContent).toContain("Butler Agent를 준비합니다");
  expect(rendered.container.textContent).toContain("준비 완료");
  expect(rendered.container.textContent).not.toContain("기존 Agent 연결");
  expect(rendered.calls).toContain("startSetup");
  expect(rendered.setupModes).toEqual(["bundled-agent"]);

  await waitForText(rendered.container, "모델 설정");
  expect(rendered.container.textContent).toContain(
    "모델은 지금 설정하거나 나중에 설정할 수 있습니다.",
  );

  await act(async () => rendered.root.unmount());
});

test("first-run setup does not expose existing-Agent connection after failure", async () => {
  const rendered = await renderFirstRun({
    ...createInitialFirstRunState("ko"),
    step: "install",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "failed",
  });

  expect(rendered.container.textContent).not.toContain("기존 Agent 연결");
  expect(rendered.container.textContent).not.toContain("고급");
  expect(rendered.container.textContent).not.toContain("gateway");
  expect(rendered.setupModes).toEqual([]);

  await act(async () => rendered.root.unmount());
});

test("first-run setup keeps waiting for bundled Agent without alternate connection path", async () => {
  const bundled = deferred<void>();
  const rendered = await renderFirstRun(
    {
      ...createInitialFirstRunState("ko"),
      step: "install",
      language_confirmed: true,
      safety_accepted: true,
      install_status: "checking",
    },
    {
      holdBundledAgent: bundled.promise,
    },
  );

  await waitForText(rendered.container, "Butler Agent를 준비합니다");
  expect(rendered.container.textContent).not.toContain("고급");
  expect(rendered.container.textContent).not.toContain("기존 Agent 연결");
  expect(rendered.container.textContent).not.toContain("모델 설정");

  bundled.resolve();
  await waitForText(rendered.container, "모델 설정");
  await clickButton(rendered.container, "나중에 설정");
  expect(rendered.setupModes).toEqual(["bundled-agent"]);
  expect(rendered.completedStates[0]?.connection_mode).toBe("bundled-agent");

  await act(async () => rendered.root.unmount());
});

test("first-run setup shows concise retry after install readiness failure", async () => {
  const rendered = await renderFirstRun(
    {
      ...createInitialFirstRunState("en"),
      step: "install",
      language_confirmed: true,
      safety_accepted: true,
      install_status: "checking",
    },
    { failHealthOnce: true },
  );

  await waitForText(rendered.container, "Butler Agent is not ready.");
  expect(rendered.container.textContent).toContain("Retry");
  expect(rendered.container.textContent).not.toContain("stack");
  expect(rendered.container.textContent).not.toContain("runtime path");

  await clickButton(rendered.container, "Retry");
  await waitForText(rendered.container, "Model setup");
  expect(rendered.calls.filter((call) => call === "startSetup")).toHaveLength(2);

  await act(async () => rendered.root.unmount());
});

test("first-run setup does not persist raw bridge errors", async () => {
  const rendered = await renderFirstRun(
    {
      ...createInitialFirstRunState("en"),
      step: "install",
      language_confirmed: true,
      safety_accepted: true,
      install_status: "checking",
    },
    { rejectSetupOnce: true },
  );

  await waitForText(rendered.container, "Butler Agent is not ready.");
  const storedState = rendered.container.ownerDocument.defaultView?.localStorage
    .getItem("butler:first-run-setup:v1") ?? "";
  expect(rendered.container.textContent).not.toContain("/Users/example/.butler");
  expect(storedState).not.toContain("/Users/example/.butler");
  expect(storedState).toContain("setup_failed");

  await act(async () => rendered.root.unmount());
});

async function renderFirstRun(
  initialState: FirstRunState,
  options: {
    failHealthOnce?: boolean;
    holdBundledAgent?: Promise<void>;
    rejectSetupOnce?: boolean;
  } = {},
): Promise<RenderedFirstRun> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>",
    { url: "http://127.0.0.1:5173" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  });
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

  const calls: string[] = [];
  const completedStates: FirstRunState[] = [];
  const setupModes: string[] = [];
  let setupFailures = options.failHealthOnce ? 1 : 0;
  let setupRejections = options.rejectSetupOnce ? 1 : 0;
  Object.assign(dom.window, {
    butlerApp: {
      startSetup: async (request?: { mode?: string }) => {
        calls.push("startSetup");
        setupModes.push(request?.mode ?? "bundled-agent");
        if (options.holdBundledAgent) {
          await options.holdBundledAgent;
        }
        if (setupRejections > 0) {
          setupRejections -= 1;
          throw new Error("Failed at /Users/example/.butler/private.env");
        }
        if (setupFailures > 0) {
          setupFailures -= 1;
          return {
            diagnostics_available: true,
            error_code: "setup_failed",
            phase: "failed",
            status_label: "Butler Agent is not ready.",
          };
        }
        return {
          diagnostics_available: true,
          phase: "ready",
          status_label: "준비 완료",
        };
      },
      updateSettings: async () => {
        calls.push("updateSettings");
        return {};
      },
    },
  });

  const container = dom.window.document.getElementById("root");
  if (!container) throw new Error("Missing test root");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <FirstRunSetup
        initialState={initialState}
        onComplete={(_mode, state) => completedStates.push(state)}
      />,
    );
  });
  return { calls, completedStates, container, root, setupModes };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  const win = container.ownerDocument.defaultView;
  if (!win) throw new Error("Missing DOM window");
  await act(async () => {
    button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  });
}

async function waitForText(
  container: HTMLElement,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 1200;
  while (!container.textContent?.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for text: ${text}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

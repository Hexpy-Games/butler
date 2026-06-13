/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import {
  createInitialFirstRunState,
  type FirstRunState,
} from "@/app/firstRunSetup.ts";
import type {
  AppModelSummary,
  ModelCatalogView,
  SettingsView,
} from "@/app/types.ts";
import { FirstRunSetup } from "./FirstRunSetup";

interface RenderedFirstRun {
  calls: string[];
  container: HTMLElement;
  completedStates: FirstRunState[];
  copiedDiagnostics: string[];
  root: Root;
  settingsPatches: unknown[];
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
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
});

test("first-run setup renders the minimal Electron setup order", async () => {
  const rendered = await renderFirstRun(createInitialFirstRunState("ko"));

  expect(rendered.container.textContent).toContain("언어 선택");
  expect(rendered.container.textContent).toContain("Butler");
  expect(
    rendered.container.querySelector('[data-test-class="new-chat-fluid-gradient"]'),
  ).not.toBeNull();
  expect(rendered.container.querySelector('[data-slot="tinted-glass"]')).not.toBeNull();
  expect(rendered.container.querySelector("ol button")).toBeNull();
  expect(rendered.container.querySelector('[aria-current="step"]')?.textContent)
    .toContain("언어");
  expect(rendered.container.textContent).not.toContain("gateway");
  expect(rendered.container.textContent).not.toContain("persona");

  await clickButton(rendered.container, "계속");
  expect(rendered.calls).toContain("updateSettings");
  expect(rendered.container.textContent).toContain("안전고지");
  expect(rendered.container.querySelector('[aria-current="step"]')?.textContent)
    .toContain("안전고지");

  await clickButton(rendered.container, "동의");
  expect(rendered.container.textContent).toContain("Butler Agent를 준비합니다");
  expect(rendered.container.textContent).toContain("준비 완료");
  expect(rendered.container.textContent).not.toContain("기존 Agent 연결");
  expect(rendered.calls).toContain("startSetup");
  expect(rendered.setupModes).toEqual(["bundled-agent"]);

  await waitForText(rendered.container, "모델 설정");
  expect(rendered.container.textContent).toContain(
    "기본 모델과 연결 방식을 설정하세요.",
  );
  await waitForText(rendered.container, "기본 모델");
  expect(
    rendered.container.querySelector(
      '[data-test-class="settings-primary-model-select"]',
    ),
  ).not.toBeNull();
  expect(rendered.container.querySelector("select")).toBeNull();
  await clickButton(rendered.container, "모델 관리");
  await waitForText(rendered.container, "등록된 모델");
  await clickButton(rendered.container, "모델 추가");
  await waitForText(rendered.container, "API key");
  expect(buttonByLabel(rendered.container, "저장하고 시작")).toBeUndefined();
  expect(
    rendered.container.querySelector(
      '[data-test-class="model-add-provider-select"]',
    ),
  ).not.toBeNull();
  expect(
    rendered.container.querySelector(
      '[data-test-class="hosted-auth-method-select"]',
    ),
  ).not.toBeNull();
  await clickButtonByAriaLabel(rendered.container, "돌아가기");
  await waitForText(rendered.container, "저장하고 시작");
  await clickButton(rendered.container, "저장하고 시작");
  expect(rendered.completedStates[0]?.status).toBe("complete");

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
  await waitForText(rendered.container, "저장하고 시작");
  await clickButton(rendered.container, "저장하고 시작");
  expect(rendered.setupModes).toEqual(["bundled-agent"]);
  expect(rendered.completedStates[0]?.connection_mode).toBe("bundled-agent");

  await act(async () => rendered.root.unmount());
});

test("first-run model setup surfaces catalog load failure and retries", async () => {
  const rendered = await renderFirstRun(
    {
      ...createInitialFirstRunState("ko"),
      step: "model",
      language_confirmed: true,
      safety_accepted: true,
      install_status: "ready",
    },
    { failModelCatalogOnce: true },
  );

  await waitForText(rendered.container, "모델 목록을 불러오지 못했습니다.");
  expect(buttonByLabel(rendered.container, "저장하고 시작")).toBeUndefined();
  await clickButton(rendered.container, "다시 불러오기");
  await waitForText(rendered.container, "저장하고 시작");
  await clickButton(rendered.container, "저장하고 시작");

  expect(rendered.completedStates[0]?.status).toBe("complete");

  await act(async () => rendered.root.unmount());
});

test("first-run model setup persists the first registered model when current default is unavailable", async () => {
  const rendered = await renderFirstRun(
    {
      ...createInitialFirstRunState("ko"),
      step: "model",
      language_confirmed: true,
      safety_accepted: true,
      install_status: "ready",
    },
    {
      modelCatalog: registeredOnlyModelCatalog(),
      settings: { ...EMPTY_SETTINGS, model: "openai/gpt-5.5" },
    },
  );

  await waitForText(rendered.container, "저장하고 시작");
  expect(rendered.settingsPatches).toContainEqual({
    model: "local/llama-3.3",
    reasoning_effort: "medium",
    context_window_tokens: 8192,
  });
  await clickButton(rendered.container, "저장하고 시작");
  expect(rendered.completedStates[0]?.status).toBe("complete");

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
  expect(rendered.container.textContent).toContain("Copy diagnostics");
  expect(rendered.container.textContent).toContain("Quit");
  expect(rendered.container.textContent).not.toContain("stack");
  expect(rendered.container.textContent).not.toContain("runtime path");

  await clickButton(rendered.container, "Copy diagnostics");
  expect(rendered.calls).toContain("exportSetupDiagnostics");
  expect(rendered.copiedDiagnostics).toHaveLength(1);
  expect(rendered.copiedDiagnostics[0]).toContain("[redacted-path]");
  expect(rendered.copiedDiagnostics[0]).not.toContain("/Users/example/.butler");
  expect(rendered.container.textContent).toContain("Diagnostics copied.");

  await clickButton(rendered.container, "Quit");
  expect(rendered.calls).toContain("quitApp");

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
    failModelCatalogOnce?: boolean;
    holdBundledAgent?: Promise<void>;
    modelCatalog?: ModelCatalogView;
    rejectSetupOnce?: boolean;
    settings?: SettingsView;
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
    DocumentFragment: dom.window.DocumentFragment,
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

  const calls: string[] = [];
  const copiedDiagnostics: string[] = [];
  const completedStates: FirstRunState[] = [];
  const settingsPatches: unknown[] = [];
  const setupModes: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedDiagnostics.push(value);
      },
    },
  });
  let setupFailures = options.failHealthOnce ? 1 : 0;
  let modelCatalogFailures = options.failModelCatalogOnce ? 1 : 0;
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
      exportSetupDiagnostics: async () => {
        calls.push("exportSetupDiagnostics");
        return {
          generated_at: "2026-06-12T00:00:00.000Z",
          phase: "failed",
          checks: [],
          errors: [
            {
              code: "setup_failed",
              message: "Butler Agent is not ready.",
              details: {
                runtime_home: "[redacted-path]",
              },
            },
          ],
        };
      },
      quitApp: async () => {
        calls.push("quitApp");
        return { quitting: true };
      },
      getModelCatalog: async () => {
        calls.push("getModelCatalog");
        if (modelCatalogFailures > 0) {
          modelCatalogFailures -= 1;
          throw new Error("model catalog failed");
        }
        return options.modelCatalog ?? firstRunModelCatalog();
      },
      getSettings: async () => {
        calls.push("getSettings");
        return options.settings ?? EMPTY_SETTINGS;
      },
      updateSettings: async (patch?: unknown) => {
        calls.push("updateSettings");
        settingsPatches.push(patch);
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
  return {
    calls,
    completedStates,
    copiedDiagnostics,
    container,
    root,
    settingsPatches,
    setupModes,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = buttonByLabel(container, label);
  if (!button) throw new Error(`Missing button: ${label}`);
  const win = container.ownerDocument.defaultView;
  if (!win) throw new Error("Missing DOM window");
  await act(async () => {
    button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  });
}

async function clickButtonByAriaLabel(
  container: HTMLElement,
  label: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing button aria-label: ${label}`);
  const win = container.ownerDocument.defaultView;
  if (!win) throw new Error("Missing DOM window");
  await act(async () => {
    button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  });
}

function buttonByLabel(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

function firstRunModelCatalog() {
  const defaultModel = EMPTY_MODEL_CATALOG.models[0]!;
  return {
    ...EMPTY_MODEL_CATALOG,
    providers: [
      {
        provider_id: "openai",
        provider_label: "OpenAI",
        latest_model_ref: defaultModel.model_ref,
        auth_methods: ["api_key", "codex_oauth"] as const,
        models: [defaultModel],
      },
    ],
    registered_models: [],
  };
}

function registeredOnlyModelCatalog(): ModelCatalogView {
  const localModel: AppModelSummary = {
    ...EMPTY_MODEL_CATALOG.models[0]!,
    provider_id: "local",
    provider_label: "Local",
    model_id: "llama-3.3",
    model_ref: "local/llama-3.3",
    display_name: "Llama 3.3",
    context_window_tokens: 8192,
    default_reasoning_effort: "medium" as const,
    reasoning_efforts: ["none", "low", "medium"],
    runtime_supported: true,
    registered: true,
  };
  return {
    ...EMPTY_MODEL_CATALOG,
    default_model_ref: localModel.model_ref,
    models: [localModel],
    registered_models: [localModel],
  };
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

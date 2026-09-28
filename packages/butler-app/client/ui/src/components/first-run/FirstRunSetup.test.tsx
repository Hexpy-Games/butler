/// <reference types="bun" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { FIRST_RUN_TEST_MODEL } from "@/app/fixtures.ts";
import { FIRST_RUN_CONSENT_VERSION } from "@/app/onboarding.ts";
import type { AppModelSummary, ModelCatalogView, SettingsView, TimelineEvent } from "@/app/types.ts";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { FirstRunSetup, type FirstRunMode, type FirstRunResult } from "./FirstRunSetup";
import { KEY_VERIFY_DEBOUNCE_MS } from "./useKeyVerification";

// First run switches the app locale and saves settings into the app store;
// hand both back unchanged for later test files.
const initialAppLocale = getAppLocale();
const initialButlerState = useButlerStore.getState();
afterAll(() => {
  setAppCopyLanguage(initialAppLocale);
  useButlerStore.setState(initialButlerState, true);
});

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
type Envelope = { ok: true; data: unknown } | { ok: false; error: { schema: string; code: string; status?: number } };

interface HarnessOptions {
  mode?: FirstRunMode;
  language?: string;
  online?: boolean;
  /** Local preparation result (`POST /setup/start`); a promise holds it. */
  setup?: Array<{ phase: string; error_code?: string } | Promise<{ phase: string }>>;
  /** Agent readiness answers, in order; the last one repeats. Omit for a pre-#230 bridge. */
  readiness?: unknown[];
  /** `POST /setup/readiness/retry` answer. */
  retryReadiness?: unknown;
  localServers?: unknown[];
  verify?: (apiKey: string) => Envelope;
  /** `verified` of a successful key check (false: the service has no model list). */
  verified?: boolean;
  /** `created` of `POST /credentials` (false: the same key was already saved). */
  created?: boolean;
  /** Failure envelope of `POST /credentials` (after a passed check). */
  saveError?: { code: string; status: number };
  /** No desktop preparation (the app served by the agent in a browser). */
  noDesktopSetup?: boolean;
  /** Status `POST /setup/oauth/{flow_id}/cancel` answers (`completed` once the code exchange finished). */
  cancelStatus?: string;
  /** ChatGPT sign-in: the agent's #279 routes, or the desktop helper for an older agent. */
  oauth?: { backend?: "agent" | "desktop"; start: Record<string, unknown>; statuses?: Array<Record<string, unknown>> };
  settings?: Partial<SettingsView>;
  /** The catalog the workspace already loaded (Run setup again). */
  storeCatalog?: ModelCatalogView;
  /** Hosted registrations that fail before one succeeds. */
  failRegistrations?: number;
  discovered?: AppModelSummary[];
}

interface Harness {
  container: HTMLElement;
  root: Root;
  calls: Array<{ method: string; input?: unknown }>;
  results: FirstRunResult[];
  clipboard: string[];
  opened: string[];
  emit: (event: { type: string; payload?: unknown }) => void;
  window: JSDOM["window"];
}

const mountedRoots = new Set<Root>();

afterEach(async () => {
  // A failed test never reaches its own unmount; stale roots would react to later locale changes.
  for (const root of mountedRoots) await act(async () => root.unmount());
  mountedRoots.clear();
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "DocumentFragment"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

const sonnet: AppModelSummary = {
  ...FIRST_RUN_TEST_MODEL, provider_id: "anthropic", provider_label: "Anthropic", model_id: "claude-sonnet-5",
  model_ref: "anthropic/claude-sonnet-5", display_name: "Claude Sonnet 5", default_reasoning_effort: "xhigh", context_window_tokens: 200_000,
};
const opus: AppModelSummary = { ...sonnet, model_id: "claude-opus-5-5", model_ref: "anthropic/claude-opus-5-5", display_name: "Claude Opus 5.5" };
const sol: AppModelSummary = { ...FIRST_RUN_TEST_MODEL, model_id: "gpt-6-sol", model_ref: "openai/gpt-6-sol", display_name: "GPT-6 Sol" };
const astra: AppModelSummary = { ...FIRST_RUN_TEST_MODEL, model_id: "gpt-6-astra", model_ref: "openai/gpt-6-astra", display_name: "GPT-6 Astra" };

function catalog(registered: AppModelSummary[] = []): ModelCatalogView {
  return {
    ...EMPTY_MODEL_CATALOG,
    providers: [
      { provider_id: "openai", provider_label: "OpenAI", latest_model_ref: astra.model_ref, models: [astra, sol],
        presets: { routine: { model: "openai/gpt-6-sol", effort: "medium" } } },
      { provider_id: "anthropic", provider_label: "Anthropic", latest_model_ref: opus.model_ref, models: [opus, sonnet],
        presets: { routine: { model: "anthropic/claude-sonnet-5", effort: "medium" } } },
    ],
    registered_models: registered,
  };
}

async function renderFirstRun(options: HarnessOptions = {}): Promise<Harness> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://127.0.0.1:5173" });
  Object.defineProperty(dom.window.navigator, "languages", { configurable: true, value: [options.language ?? "ko-KR"] });
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, get: () => options.online ?? true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, DocumentFragment: dom.window.DocumentFragment,
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  useButlerStore.setState({
    settings: { ...EMPTY_SETTINGS, onboarding: {}, ...options.settings },
    modelCatalog: options.storeCatalog ?? EMPTY_MODEL_CATALOG,
  });

  const calls: Harness["calls"] = [];
  const results: FirstRunResult[] = [];
  const clipboard: string[] = [];
  const opened: string[] = [];
  Object.assign(dom.window, { open: (url: string) => void opened.push(url) });
  const listeners = new Set<(event: TimelineEvent) => void>();
  const setup = [...(options.setup ?? [{ phase: "ready" }])];
  const readiness = [...(options.readiness ?? [])];
  const statuses = [...(options.oauth?.statuses ?? [])];
  const nextStatus = () => (statuses.length > 1 ? statuses.shift() : statuses[0] ?? options.oauth?.start);
  const record = (method: string, input?: unknown) => calls.push({ method, input });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true, value: { writeText: async (value: string) => void clipboard.push(value) },
  });
  const bridge: Record<string, unknown> = {
    startSetup: async (input: unknown) => {
      record("startSetup", input);
      const next = setup.length > 1 ? setup.shift()! : setup[0]!;
      return { diagnostics_available: true, ...(await next) };
    },
    exportSetupDiagnostics: async () => ({
      generated_at: "t", phase: "failed", checks: [{ id: "agent_service", status: "failed" }], errors: [{ code: "agent_service_failed" }],
    }),
    subscribeLiveEvents: (_input: unknown, handlers: { onEvent?: (event: TimelineEvent) => void }) => {
      record("subscribeLiveEvents");
      const listener = (event: TimelineEvent) => handlers.onEvent?.(event);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLocalModelServers: async () => {
      record("getLocalModelServers");
      return { servers: options.localServers ?? [] };
    },
    verifySetupCredential: async (input: { api_key: string }) => {
      record("verifySetupCredential", input);
      return options.verify?.(input.api_key) ?? { ok: true, data: { valid: true, verified: options.verified ?? true, models: ["claude-sonnet-5"] } };
    },
    saveCredential: async (input: { provider_id: string }) => {
      record("saveCredential", input);
      if (options.saveError) return { ok: false, error: { schema: "butler.app.bridge-error.v1", ...options.saveError } };
      const credential = { id: "cred-new", label: input.provider_id, provider_id: input.provider_id, auth_type: "api_key", masked_value: "sk-...al" };
      return { ok: true, data: { credential, created: options.created ?? true } };
    },
    // Desktop sign-in helper (fallback).
    startOpenAIOAuthLogin: async () => {
      record("startOpenAIOAuthLogin");
      return options.oauth?.start ?? { status: "completed" };
    },
    getOpenAIOAuthLoginStatus: async () => nextStatus(),
    cancelOpenAIOAuthLogin: async (input: unknown) => {
      record("cancelOpenAIOAuthLogin", input);
      return { status: "cancelled" };
    },
    getModelCatalog: async () => catalog(),
    discoverLocalModels: async (input: unknown) => {
      record("discoverLocalModels", input);
      return { server_url: "http://127.0.0.1:8080/v1", platform: "custom", models: options.discovered ?? [] };
    },
    getSettings: async () => ({ ...EMPTY_SETTINGS, onboarding: {}, ...options.settings }),
    registerHostedModel: async (input: { model_id: string }) => {
      record("registerHostedModel", input);
      const attempts = calls.filter((call) => call.method === "registerHostedModel").length;
      if (attempts <= (options.failRegistrations ?? 0)) throw new Error("registration failed");
      const model = [astra, sol, opus, sonnet].find((entry) => entry.model_id === input.model_id)!;
      return { model: { ...model, registered: true }, catalog: catalog([model]) };
    },
    registerLocalModel: async (input: { model_id: string }) => {
      record("registerLocalModel", input);
      const model = { ...FIRST_RUN_TEST_MODEL, provider_id: "local", model_id: input.model_id, model_ref: `local/${input.model_id}`, default_reasoning_effort: "medium" as const };
      return { model, catalog: catalog([model]) };
    },
    updateSettings: async (patch: unknown) => {
      record("updateSettings", patch);
      return { ok: true, data: {} };
    },
    quitApp: async () => record("quitApp"),
  };
  if (options.readiness) {
    bridge.getSetupReadiness = async () => {
      record("getSetupReadiness");
      return { ok: true, data: readiness.length > 1 ? readiness.shift() : readiness[0] };
    };
    bridge.retrySetupReadiness = async () => {
      record("retrySetupReadiness");
      // The agent now reports the new run.
      const view = options.retryReadiness ?? { status: "preparing", steps: [] };
      readiness.splice(0, readiness.length, view);
      return { ok: true, data: view };
    };
  }
  if ((options.oauth?.backend ?? "agent") === "agent") {
    // #279 agent routes.
    bridge.startSetupOAuth = async (input: unknown) => {
      record("startSetupOAuth", input);
      return { ok: true, data: options.oauth?.start ?? { flow_id: "oauth_1", status: "profile_exists" } };
    };
    bridge.getSetupOAuthFlow = async (input: unknown) => {
      record("getSetupOAuthFlow", input);
      return { ok: true, data: nextStatus() };
    };
    bridge.cancelSetupOAuth = async (input: { flowId: string }) => {
      record("cancelSetupOAuth", input);
      return { ok: true, data: { flow_id: input.flowId, status: options.cancelStatus ?? "cancelled" } };
    };
  }
  if (options.noDesktopSetup) delete bridge.startSetup;
  Object.assign(dom.window, { butlerApp: bridge });

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => {
    root.render(<FirstRunSetup mode={options.mode ?? "first-run"} onComplete={(result) => results.push(result)} />);
  });
  return {
    container, root, calls, results, clipboard, opened, window: dom.window,
    emit: (event) => {
      for (const listener of listeners) listener(event as TimelineEvent);
    },
  };
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, label: string, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await settle(25);
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
}

async function click(harness: Harness, target: string | Element): Promise<void> {
  const element = typeof target === "string" ? buttonByText(harness.container, target) : target;
  if (!element) throw new Error(`Missing button: ${String(target)}`);
  await act(async () => {
    element.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
  });
}

async function type(harness: Harness, input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(harness.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  });
}

async function unmount(harness: Harness): Promise<void> {
  mountedRoots.delete(harness.root);
  await act(async () => harness.root.unmount());
}

function text(harness: Harness): string {
  return harness.container.textContent ?? "";
}

function methods(harness: Harness, method: string) {
  return harness.calls.filter((call) => call.method === method);
}

async function agree(harness: Harness): Promise<void> {
  await waitFor(() => !buttonByText(harness.container, "동의하고 계속")?.disabled, "agree enabled");
  await click(harness, "동의하고 계속");
}

function card(harness: Harness, cardId: string): HTMLButtonElement {
  const element = harness.container.querySelector<HTMLButtonElement>(`[data-card-id="${cardId}"]`);
  if (!element) throw new Error(`Missing card ${cardId}`);
  return element;
}

test("welcome shows three consent lines and one button while Butler prepares in the background", async () => {
  let release!: (value: { phase: string }) => void;
  const harness = await renderFirstRun({ setup: [new Promise((resolve) => { release = resolve; })] });
  expect(text(harness)).toContain("반갑습니다");
  expect(harness.container.querySelectorAll('[role="listitem"]')).toHaveLength(3);
  expect(text(harness)).toContain("바꾸기 전에 먼저 묻습니다");
  expect(text(harness)).not.toMatch(/OAuth|credential|provider|endpoint|자동화/u);
  expect(harness.container.querySelector('[data-test-class="first-run-prep"]')?.textContent).toContain("Butler 준비 중");
  expect(harness.container.querySelector("ol")).toBeNull();
  expect(methods(harness, "startSetup")).toHaveLength(1);
  await act(async () => release({ phase: "ready" }));
  await waitFor(() => text(harness).includes("준비됨"), "ready line");
  await unmount(harness);
});

test("a failed preparation shows a plain reason inline, blocks consent and retries", async () => {
  const harness = await renderFirstRun({ setup: [{ phase: "failed", error_code: "agent_service_failed" }, { phase: "ready" }] });
  await waitFor(() => Boolean(harness.container.querySelector('[data-test-class="first-run-prep-failed"]')), "failure notice");
  expect(text(harness)).toContain("Butler를 시작하지 못했습니다.");
  expect(text(harness)).toContain("백그라운드 서비스가 멈췄습니다.");
  expect(buttonByText(harness.container, "동의하고 계속")?.disabled).toBe(true);
  expect(buttonByText(harness.container, "동의하고 계속")?.getAttribute("title")).toBe("Butler를 시작해야 계속할 수 있습니다");
  await click(harness, "다시 시도");
  await waitFor(() => text(harness).includes("준비됨"), "ready after retry");
  expect(methods(harness, "startSetup").map((call) => (call.input as { mode: string }).mode)).toEqual(["check", "check"]);
  expect(buttonByText(harness.container, "동의하고 계속")?.disabled).toBe(false);
  await unmount(harness);
});

test("agent readiness shows step progress and follows setup.readiness_changed", async () => {
  const preparing = {
    status: "preparing",
    steps: [{ id: "data_folder", status: "done" }, { id: "model_config", status: "running" }, { id: "agent_runtime", status: "pending" }],
  };
  const harness = await renderFirstRun({ readiness: [preparing] });
  await waitFor(() => text(harness).includes("1/3"), "progress");
  expect(methods(harness, "subscribeLiveEvents").length).toBeGreaterThan(0);
  await act(async () => harness.emit({ type: "setup.readiness_changed", payload: { status: "ready", steps: [] } }));
  await waitFor(() => text(harness).includes("준비됨"), "ready from event");
  await unmount(harness);
});

test("an agent-side failure shows its plain reason; Try again re-runs the agent's preparation only", async () => {
  const failed = {
    status: "failed",
    steps: [
      { id: "data_folder", status: "failed", error: { code: "data_folder_unwritable", detail: "probe write failed: permission denied" } },
      { id: "model_config", status: "pending" },
      { id: "agent_runtime", status: "pending" },
    ],
  };
  const harness = await renderFirstRun({ readiness: [failed], retryReadiness: { status: "preparing", steps: [] } });
  await waitFor(() => Boolean(harness.container.querySelector('[data-test-class="first-run-prep-failed"]')), "failure notice");
  expect(text(harness)).toContain("데이터 폴더(~/.butler)에 쓸 수 없습니다.");
  expect(text(harness)).not.toContain("permission denied");
  await click(harness, "다시 시도");
  await waitFor(() => methods(harness, "retrySetupReadiness").length === 1, "retry route");
  expect(methods(harness, "startSetup")).toHaveLength(1);
  await act(async () => harness.emit({ type: "setup.readiness_changed", payload: { status: "ready", steps: [] } }));
  await waitFor(() => text(harness).includes("준비됨"), "ready after retry");
  await unmount(harness);
});

test("Pick an AI: three well-known cards on top, the rest behind a toggle in an equal-size grid", async () => {
  const harness = await renderFirstRun();
  await agree(harness);
  await waitFor(() => text(harness).includes("어떤 AI와 일할까요?"), "connect title");
  const top = Array.from(harness.container.querySelectorAll('[data-test-class="first-run-top-cards"] [data-card-id]'));
  expect(top.map((element) => element.getAttribute("data-card-id"))).toEqual(["chatgpt", "claude", "gemini"]);
  expect(card(harness, "chatgpt").textContent).toContain("키 필요 없음");
  const toggle = buttonByText(harness.container, "다른 서비스 8개")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(harness, toggle);
  const grid = harness.container.querySelector('[data-test-class="first-run-more-providers"]')!;
  expect(grid.getAttribute("data-slot")).toBe("choice-tile-grid");
  const tiles = Array.from(grid.querySelectorAll(":scope > li > button"));
  expect(tiles.map((element) => element.getAttribute("data-card-id"))).toEqual(
    ["local", "openai", "grok", "qwen", "kimi", "zaiCoding", "zaiApi", "opencodeGo", "other"],
  );
  expect(tiles[0]!.getAttribute("data-placeholder")).toBe("true");
  for (const tile of tiles) expect(tile.querySelector('[data-slot="choice-tile-title"]')?.getAttribute("data-line-clamp")).toBe("2");
  expect(tiles.at(-1)!.textContent).toContain("기타 (OpenAI 호환)");
  await unmount(harness);
});

test("This computer joins the top cards when a local server answers, and its models start Butler", async () => {
  const harness = await renderFirstRun({
    localServers: [{ id: "ollama", label: "Ollama", base_url: "http://127.0.0.1:11434", reachable: true,
      models: [{ id: "qwen3:8b", size_bytes: 5_200_000_000 }, { id: "gemma3:12b", size_bytes: 8_100_000_000 }] }],
  });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="local"]')), "local card");
  expect(card(harness, "local").textContent).toContain("무료 · 비공개");
  expect(card(harness, "local").textContent).toContain("모델 2개 · Ollama");
  await click(harness, card(harness, "local"));
  const radios = Array.from(harness.container.querySelectorAll('[role="radio"]'));
  expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(radios[0]!.textContent).toContain("5.2 GB");
  await click(harness, radios[1]!);
  await click(harness, "이 모델로 시작");
  await waitFor(() => harness.results.length === 1, "completion");
  expect(methods(harness, "registerLocalModel")[0]!.input).toMatchObject({
    platform: "ollama", server_url: "http://127.0.0.1:11434", model_id: "gemma3:12b", provider_id: "local",
  });
  const patch = methods(harness, "updateSettings").at(-1)!.input as Record<string, unknown>;
  expect(patch).toMatchObject({ model: "local/gemma3:12b", language: "ko" });
  expect(patch.onboarding).toMatchObject({ consent_version: FIRST_RUN_CONSENT_VERSION });
  expect(harness.results[0]).toEqual({ cardId: "local" });
  await unmount(harness);
});

test("an API key is checked once after the paste debounce, saved, and connects the routine preset", async () => {
  const harness = await renderFirstRun();
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  await click(harness, card(harness, "claude"));
  expect(text(harness)).toContain("Claude 연결");
  expect(harness.container.querySelector('a[href="https://console.anthropic.com/settings/keys"]')?.textContent).toContain("키 발급받기");
  expect(harness.container.querySelectorAll("input")).toHaveLength(1);
  const input = harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!;
  await type(harness, input, "sk-ant");
  await type(harness, input, "sk-ant-api03-first");
  await type(harness, input, "sk-ant-api03-final");
  await settle(KEY_VERIFY_DEBOUNCE_MS / 2);
  expect(methods(harness, "verifySetupCredential")).toHaveLength(0);
  await waitFor(() => harness.results.length === 1, "completion");
  expect(methods(harness, "verifySetupCredential").map((call) => call.input)).toEqual([
    { provider_id: "anthropic", api_key: "sk-ant-api03-final" },
  ]);
  expect(methods(harness, "saveCredential")[0]!.input).toEqual({ provider_id: "anthropic", api_key: "sk-ant-api03-final" });
  expect(methods(harness, "registerHostedModel")[0]!.input).toEqual({
    provider_id: "anthropic", model_id: "claude-sonnet-5", auth_type: "api_key", credential_id: "cred-new",
  });
  const patch = methods(harness, "updateSettings").at(-1)!.input as SettingsView;
  expect(patch).toMatchObject({ model: "anthropic/claude-sonnet-5", reasoning_effort: "medium" });
  expect(patch.worker_profiles.every((profile) => profile.reasoning_effort === "medium")).toBe(true);
  expect(typeof patch.onboarding?.completed_at).toBe("string");
  expect(harness.results[0]).toEqual({ cardId: "claude" });
  await unmount(harness);
});

test("a key the service cannot check is saved; a key saved before is reused (created: false)", async () => {
  const harness = await renderFirstRun({ verified: false, created: false });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  await click(harness, card(harness, "claude"));
  await type(harness, harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!, "sk-ant-api03-again");
  await waitFor(() => text(harness).includes("저장했습니다"), "saved line");
  await waitFor(() => harness.results.length === 1, "completion");
  expect(methods(harness, "registerHostedModel")[0]!.input).toMatchObject({ credential_id: "cred-new", auth_type: "api_key" });
  await unmount(harness);
});

test("every #279 key error code maps to a plain message inline and keeps the pasted key", async () => {
  const codes: Record<string, [string, number]> = {
    "bad-key-000": ["invalid_key", 422], "no-access-00": ["no_access", 422], "offline-0000": ["network", 502],
    "too-many-000": ["rate_limited", 429], "down-000000": ["provider_unavailable", 502],
    "unsupported-0": ["unsupported_provider", 400], "malformed-00": ["invalid_request", 400],
  };
  const harness = await renderFirstRun({
    verify: (key) => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: codes[key]![0], status: codes[key]![1] } }),
  });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  await click(harness, card(harness, "claude"));
  const input = harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!;
  const expected = [
    ["bad-key-000", "이 키로 연결할 수 없습니다."],
    ["no-access-00", "이 키로는 모델을 쓸 수 없습니다."],
    ["offline-0000", "서비스에 연결할 수 없습니다."],
    ["too-many-000", "요청이 너무 많습니다."],
    ["down-000000", "서비스가 응답하지 않습니다."],
    ["unsupported-0", "이 서비스의 키는 아직 확인할 수 없습니다."],
    ["malformed-00", "키를 확인하지 못했습니다."],
  ];
  const retryable = new Set(["offline-0000", "too-many-000", "down-000000"]);
  for (const [key, message] of expected) {
    await type(harness, input, key!);
    await waitFor(() => text(harness).includes(message!), message!);
    expect(input.value).toBe(key!);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(Boolean(buttonByText(harness.container, "다시 시도"))).toBe(retryable.has(key!));
  }
  // Try again checks the same key without a new paste.
  const before = methods(harness, "verifySetupCredential").length;
  await type(harness, input, "offline-0000");
  await waitFor(() => Boolean(buttonByText(harness.container, "다시 시도")), "retry link");
  const afterPaste = methods(harness, "verifySetupCredential").length;
  await click(harness, "다시 시도");
  await waitFor(() => methods(harness, "verifySetupCredential").length === afterPaste + 1, "retried check");
  expect(afterPaste).toBe(before + 1);
  expect(methods(harness, "saveCredential")).toHaveLength(0);
  await unmount(harness);
});

test("ChatGPT sign-in runs on the agent: the app opens the browser, cancels by flow id, and can try again", async () => {
  const pending = { flow_id: "oauth_1", status: "pending", auth_url: "https://auth.openai.com/oauth/authorize?state=x" };
  const harness = await renderFirstRun({ oauth: { start: pending, statuses: [pending] } });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="chatgpt"]')), "chatgpt card");
  await click(harness, card(harness, "chatgpt"));
  await waitFor(() => text(harness).includes("브라우저에서 로그인하세요"), "waiting");
  expect(methods(harness, "startSetupOAuth")).toHaveLength(1);
  expect(methods(harness, "startOpenAIOAuthLogin")).toHaveLength(0);
  expect(harness.opened).toEqual([pending.auth_url]);
  await waitFor(() => methods(harness, "getSetupOAuthFlow").length > 0, "status poll", 3000);
  expect(methods(harness, "getSetupOAuthFlow")[0]!.input).toEqual({ flowId: "oauth_1" });
  expect(harness.opened).toHaveLength(1);
  await click(harness, "브라우저가 열리지 않았나요? 링크 복사");
  expect(harness.clipboard).toEqual([pending.auth_url]);
  await click(harness, "취소");
  await waitFor(() => text(harness).includes("로그인이 취소되었습니다"), "cancelled");
  expect(methods(harness, "cancelSetupOAuth")[0]!.input).toEqual({ flowId: "oauth_1" });
  await click(harness, "다시 시도");
  await waitFor(() => methods(harness, "startSetupOAuth").length === 2, "restart");
  await unmount(harness);
});

test("an agent without the sign-in routes falls back to the desktop helper", async () => {
  const pending = { status: "pending", flow_id: "desktop-1", auth_url: "https://auth.openai.com/oauth/authorize?state=y" };
  const harness = await renderFirstRun({ oauth: { backend: "desktop", start: pending, statuses: [pending] } });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="chatgpt"]')), "chatgpt card");
  await click(harness, card(harness, "chatgpt"));
  await waitFor(() => text(harness).includes("브라우저에서 로그인하세요"), "waiting");
  expect(methods(harness, "startOpenAIOAuthLogin")).toHaveLength(1);
  // The desktop helper opens the browser itself.
  expect(harness.opened).toEqual([]);
  await click(harness, "취소");
  await waitFor(() => text(harness).includes("로그인이 취소되었습니다"), "cancelled");
  expect(methods(harness, "cancelOpenAIOAuthLogin")[0]!.input).toEqual({ flowId: "desktop-1" });
  await unmount(harness);
});

test("a finished sign-in registers ChatGPT with its routine preset", async () => {
  const pending = { flow_id: "oauth_2", status: "pending", auth_url: "https://auth.openai.com/x" };
  const harness = await renderFirstRun({ oauth: { start: pending, statuses: [pending, { flow_id: "oauth_2", status: "completed", label: "me@example.com" }] } });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="chatgpt"]')), "chatgpt card");
  await click(harness, card(harness, "chatgpt"));
  await waitFor(() => harness.results.length === 1, "completion", 5000);
  expect(methods(harness, "registerHostedModel")[0]!.input).toEqual({ provider_id: "openai", model_id: "gpt-6-sol", auth_type: "codex_oauth" });
  expect(methods(harness, "updateSettings").at(-1)!.input).toMatchObject({ model: "openai/gpt-6-sol", reasoning_effort: "medium" });
  await unmount(harness);
});

test("finishing waits for readiness: nothing is registered until Butler is ready", async () => {
  const preparing = { status: "preparing", steps: [{ id: "a", status: "done" }, { id: "b", status: "running" }] };
  const harness = await renderFirstRun({ readiness: [preparing] });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  expect(text(harness)).toContain("Butler 준비가 끝나면 바로 연결합니다");
  await click(harness, card(harness, "claude"));
  await type(harness, harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!, "sk-ant-api03-valid");
  await waitFor(() => Boolean(harness.container.querySelector('[data-test-class="first-run-finishing"]')), "finishing view");
  expect(text(harness)).toContain("Butler 준비가 끝나면 바로 시작합니다");
  await settle(200);
  expect(methods(harness, "registerHostedModel")).toHaveLength(0);
  await act(async () => harness.emit({ type: "setup.readiness_changed", payload: { status: "ready", steps: [] } }));
  await waitFor(() => harness.results.length === 1, "completion after ready");
  expect(methods(harness, "registerHostedModel")).toHaveLength(1);
  await unmount(harness);
});

test("offline: a notice, and only models on this computer can be picked", async () => {
  const harness = await renderFirstRun({
    online: false,
    localServers: [{ id: "lm_studio", label: "LM Studio", base_url: "http://127.0.0.1:1234", reachable: true, models: [{ id: "llama-3.2-3b" }] }],
  });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="local"]')), "local card");
  expect(text(harness)).toContain("인터넷에 연결되어 있지 않습니다.");
  for (const id of ["chatgpt", "claude", "gemini"]) {
    expect(card(harness, id).getAttribute("aria-disabled")).toBe("true");
    expect(card(harness, id).textContent).toContain("오프라인에서는 쓸 수 없습니다");
  }
  await click(harness, card(harness, "claude"));
  expect(text(harness)).not.toContain("Claude 연결");
  expect(card(harness, "local").getAttribute("aria-disabled")).toBeNull();
  await unmount(harness);
});

test("no local server: This computer waits in the grid and Check again probes again", async () => {
  const harness = await renderFirstRun();
  await agree(harness);
  await waitFor(() => methods(harness, "getLocalModelServers").length > 0, "first probe");
  await click(harness, "다른 서비스 8개");
  const before = methods(harness, "getLocalModelServers").length;
  await click(harness, card(harness, "local"));
  await waitFor(() => methods(harness, "getLocalModelServers").length > before, "rescan");
  expect(harness.container.querySelector('[data-test-class="first-run-top-cards"] [data-card-id="local"]')).toBeNull();
  await unmount(harness);
});

test("a newer consent version shows only the welcome and records consent", async () => {
  const harness = await renderFirstRun({ mode: "consent", settings: { language: "ko", onboarding: { consent_version: 0, completed_at: "2026-06-01" } } });
  await agree(harness);
  await waitFor(() => harness.results.length === 1, "consent saved");
  expect(harness.results[0]).toBeNull();
  expect(text(harness)).not.toContain("어떤 AI와 일할까요?");
  const patch = methods(harness, "updateSettings").at(-1)!.input as SettingsView;
  expect(patch.onboarding).toMatchObject({ consent_version: FIRST_RUN_CONSENT_VERSION, completed_at: "2026-06-01" });
  expect(typeof patch.onboarding?.accepted_at).toBe("string");
  await unmount(harness);
});

test("the language picker switches the copy without a language screen", async () => {
  const harness = await renderFirstRun({ language: "en-US" });
  expect(text(harness)).toContain("Welcome to Butler");
  const select = harness.container.querySelector<HTMLSelectElement>("#first-run-language")!;
  expect(select.value).toBe("en");
  await act(async () => {
    select.value = "ko";
    select.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  });
  expect(text(harness)).toContain("반갑습니다");
  await unmount(harness);
});

test("a failed registration shows a plain retry and succeeds on the next try", async () => {
  const harness = await renderFirstRun({ failRegistrations: 1 });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  await click(harness, card(harness, "claude"));
  await type(harness, harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!, "sk-ant-api03-valid");
  await waitFor(() => text(harness).includes("연결을 마치지 못했습니다."), "finish failure");
  expect(harness.results).toEqual([]);
  await click(harness, "다시 시도");
  await waitFor(() => harness.results.length === 1, "completion after retry");
  expect(methods(harness, "registerHostedModel")).toHaveLength(2);
  expect(methods(harness, "saveCredential")).toHaveLength(1);
  await unmount(harness);
});

test("Other (OpenAI-compatible) finds the server's models and starts with the picked one", async () => {
  const served: AppModelSummary = {
    ...FIRST_RUN_TEST_MODEL, provider_id: "local", model_id: "mistral-small", model_ref: "local/mistral-small", context_window_tokens: 32_000,
  };
  const harness = await renderFirstRun({ discovered: [served] });
  await agree(harness);
  await waitFor(() => Boolean(buttonByText(harness.container, "다른 서비스 8개")), "more toggle");
  await click(harness, "다른 서비스 8개");
  await click(harness, card(harness, "other"));
  expect(text(harness)).toContain("OpenAI 호환 서버");
  await type(harness, harness.container.querySelector<HTMLInputElement>("#first-run-server-url")!, "http://127.0.0.1:8080/v1");
  await type(harness, harness.container.querySelector<HTMLInputElement>("#first-run-server-key")!, "local-secret");
  await click(harness, "연결");
  await waitFor(() => text(harness).includes("mistral-small"), "discovered model");
  expect(methods(harness, "discoverLocalModels")[0]!.input).toMatchObject({
    platform: "custom", server_url: "http://127.0.0.1:8080/v1", api_key: "local-secret",
  });
  await click(harness, "이 모델로 시작");
  await waitFor(() => harness.results.length === 1, "completion");
  expect(methods(harness, "registerLocalModel")[0]!.input).toMatchObject({
    platform: "custom", model_id: "mistral-small", context_window_tokens: 32_000, api_key: "local-secret",
  });
  expect(harness.results[0]).toEqual({ cardId: "other" });
  await unmount(harness);
});

test("Run setup again marks the connected AI as current and can be cancelled from the welcome", async () => {
  const connected: AppModelSummary = { ...sonnet, registered: true, auth_type: "api_key" };
  const harness = await renderFirstRun({
    mode: "rerun",
    settings: { language: "ko", model: connected.model_ref, onboarding: { consent_version: FIRST_RUN_CONSENT_VERSION, completed_at: "c" } },
    storeCatalog: catalog([connected]),
  });
  expect(buttonByText(harness.container, "취소")).toBeDefined();
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  const current = card(harness, "claude");
  expect(current.getAttribute("data-selected")).toBe("true");
  expect(current.getAttribute("aria-current")).toBe("true");
  expect(current.textContent).toContain("사용 중");
  expect(card(harness, "chatgpt").getAttribute("data-selected")).toBeNull();
  expect(card(harness, "chatgpt").getAttribute("aria-current")).toBeNull();
  await unmount(harness);
});

test("a current AI behind \"more\" opens the grid with its tile marked", async () => {
  const connected: AppModelSummary = { ...sol, registered: true, auth_type: "api_key" };
  const harness = await renderFirstRun({
    mode: "rerun",
    settings: { language: "ko", model: connected.model_ref },
    storeCatalog: catalog([connected]),
  });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-test-class="first-run-more-providers"]')), "open grid");
  expect(card(harness, "openai").getAttribute("data-selected")).toBe("true");
  expect(card(harness, "openai").getAttribute("aria-current")).toBe("true");
  expect(card(harness, "chatgpt").getAttribute("data-selected")).toBeNull();
  await unmount(harness);
});

test("a first run marks no card as current", async () => {
  const harness = await renderFirstRun({ settings: { model: sonnet.model_ref }, storeCatalog: catalog([{ ...sonnet, registered: true }]) });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  expect(harness.container.querySelector('[aria-current="true"]')).toBeNull();
  await unmount(harness);
});

test("a cancel that lands after the code exchange answers completed and continues as signed in", async () => {
  const pending = { flow_id: "oauth_3", status: "pending", auth_url: "https://auth.openai.com/z" };
  const harness = await renderFirstRun({ oauth: { start: pending, statuses: [pending] }, cancelStatus: "completed" });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="chatgpt"]')), "chatgpt card");
  await click(harness, card(harness, "chatgpt"));
  await waitFor(() => text(harness).includes("브라우저에서 로그인하세요"), "waiting");
  await click(harness, "취소");
  await waitFor(() => harness.results.length === 1, "completion after late cancel");
  expect(methods(harness, "registerHostedModel")[0]!.input).toMatchObject({ provider_id: "openai", auth_type: "codex_oauth" });
  expect(text(harness)).not.toContain("로그인이 취소되었습니다");
  await unmount(harness);
});

test("a key that passed the check but could not be saved says so and keeps the key", async () => {
  const harness = await renderFirstRun({ saveError: { code: "internal_error", status: 500 } });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  await click(harness, card(harness, "claude"));
  const input = harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!;
  await type(harness, input, "sk-ant-api03-savefail");
  await waitFor(() => text(harness).includes("키를 저장하지 못했습니다."), "save failure");
  expect(input.value).toBe("sk-ant-api03-savefail");
  expect(Boolean(buttonByText(harness.container, "다시 시도"))).toBe(true);
  expect(harness.results).toEqual([]);
  await unmount(harness);
});

test("Run setup again with the same AI keeps the existing model defaults", async () => {
  const connected: AppModelSummary = { ...opus, registered: true, auth_type: "api_key" };
  const harness = await renderFirstRun({
    mode: "rerun",
    settings: { language: "ko", model: connected.model_ref, reasoning_effort: "high", onboarding: { consent_version: FIRST_RUN_CONSENT_VERSION, completed_at: "c" } },
    storeCatalog: catalog([connected]),
  });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="claude"]')), "claude card");
  await click(harness, card(harness, "claude"));
  await type(harness, harness.container.querySelector<HTMLInputElement>("#first-run-api-key")!, "sk-ant-api03-rotated");
  await waitFor(() => harness.results.length === 1, "completion");
  // The new key goes to the model already in use; the chat default, effort and Workers stay.
  expect(methods(harness, "registerHostedModel")[0]!.input).toMatchObject({ model_id: "claude-opus-5-5", credential_id: "cred-new" });
  const patch = methods(harness, "updateSettings").at(-1)!.input as Record<string, unknown>;
  expect(patch).not.toHaveProperty("model");
  expect(patch).not.toHaveProperty("reasoning_effort");
  expect(patch).not.toHaveProperty("worker_profiles");
  expect(patch.onboarding).toMatchObject({ consent_version: FIRST_RUN_CONSENT_VERSION });
  await unmount(harness);
});

test("Run setup again with a new AI applies that service's routine preset", async () => {
  const connected: AppModelSummary = { ...opus, registered: true, auth_type: "api_key" };
  const harness = await renderFirstRun({
    mode: "rerun",
    settings: { language: "ko", model: connected.model_ref, onboarding: { consent_version: FIRST_RUN_CONSENT_VERSION, completed_at: "c" } },
    storeCatalog: catalog([connected]),
    oauth: { start: { flow_id: "oauth_4", status: "profile_exists" } },
  });
  await agree(harness);
  await waitFor(() => Boolean(harness.container.querySelector('[data-card-id="chatgpt"]')), "chatgpt card");
  await click(harness, card(harness, "chatgpt"));
  await waitFor(() => harness.results.length === 1, "completion");
  expect(methods(harness, "updateSettings").at(-1)!.input).toMatchObject({ model: "openai/gpt-6-sol", reasoning_effort: "medium" });
  await unmount(harness);
});

test("without a desktop preparation route (the app in a browser), the agent's readiness alone decides", async () => {
  const harness = await renderFirstRun({ noDesktopSetup: true, readiness: [{ status: "ready", steps: [] }] });
  await waitFor(() => text(harness).includes("준비됨"), "ready");
  expect(harness.container.querySelector('[data-test-class="first-run-prep-failed"]')).toBeNull();
  expect(methods(harness, "getSetupReadiness").length).toBeGreaterThan(0);
  await unmount(harness);
});

/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { useConfirmationStore } from "@/app/confirmation.ts";
import { getAppCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, SavedCredentialView } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { ModelsSettings } from "./ModelsSettings";
import { credentialDeleteRule, credentialStorageLabel } from "./savedKeysUtils";

const initialButlerState = useButlerStore.getState();
const initialUIState = useSettingsUIStore.getState();
afterEach(() => {
  useButlerStore.setState(initialButlerState, true);
  useSettingsUIStore.setState(initialUIState, true);
  useConfirmationStore.setState({ pending: null });
  setAppCopyLanguage("en");
});

const en = getAppCopy("en-US");
const ko = getAppCopy("ko-KR");

function key(id: string, providerId: string, modelRefs: string[], extra: Partial<SavedCredentialView> = {}): SavedCredentialView {
  return {
    id, provider_id: providerId, auth_type: "api_key", label: id, masked_value: `sk-…${id.slice(-4)}`,
    storage: "fallback_file", created_at: "t", updated_at: "t", model_refs: modelRefs, ...extra,
  };
}

const CATALOG: ModelCatalogView = {
  ...EMPTY_MODEL_CATALOG,
  default_model_ref: "openai/gpt-main",
  providers: [
    { provider_id: "openai", provider_label: "OpenAI", latest_model_ref: "", models: [] },
    { provider_id: "anthropic", provider_label: "Anthropic", latest_model_ref: "", models: [] },
    { provider_id: "google", provider_label: "Google", latest_model_ref: "", models: [] },
  ],
};

const KEYS = [
  key("openai", "openai", ["openai/gpt-main", "openai/gpt-mini"]),
  key("anthropic", "anthropic", ["anthropic/sonnet", "anthropic/haiku"]),
  key("google", "google", []),
];

type Call = { method: string; input: unknown };
type Bridge = Record<string, (input?: unknown) => unknown>;

interface Harness {
  window: JSDOM["window"];
  container: HTMLElement;
  calls: Call[];
}

async function render(bridgeOverrides: Bridge, run: (harness: Harness) => Promise<void>, keys = KEYS) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  const calls: Call[] = [];
  const record = (method: string, answer: (input?: unknown) => unknown) => async (input?: unknown) => {
    calls.push({ method, input });
    return await answer(input);
  };
  const bridge: Bridge = {
    listCredentials: record("listCredentials", () => ({ credentials: keys, store: { backend: "fallback_file", reason: "unsigned_build" } })),
    getModelCatalog: record("getModelCatalog", () => CATALOG),
    getSettings: record("getSettings", () => new Promise(() => undefined)),
    ...Object.fromEntries(Object.entries(bridgeOverrides).map(([method, answer]) => [method, record(method, answer)])),
  };
  Object.assign(dom.window, { requestAnimationFrame, cancelAnimationFrame, ResizeObserver, matchMedia, butlerApp: bridge });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame, cancelAnimationFrame, ResizeObserver, matchMedia, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.assign(globalThis, globals);
  const settings = { ...EMPTY_SETTINGS, model: "openai/gpt-main" };
  useButlerStore.setState({ settings, modelCatalog: CATALOG });
  useSettingsUIStore.setState({ draft: settings, modelRoute: { page: "root" } });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ModelsSettings />));
    await settle();
    await run({ window: dom.window, container, calls });
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-test-class="saved-key-row"]'));
const button = (scope: HTMLElement, label: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label)!;

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function type(harness: Harness, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(harness.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  });
}

async function openReplace(harness: Harness, row: HTMLElement, value: string) {
  await click(button(row, en.settings.savedKeys.replace));
  const input = row.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(input).not.toBeNull();
  await type(harness, input, value);
  return input;
}

test("one row per saved key: provider logo, masked key, models using it and where it is stored", async () => {
  await render({}, async ({ container }) => {
    // The section sits under Backup models on the Models page.
    const ids = Array.from(container.querySelectorAll("[data-settings-section-id]")).map((item) => item.getAttribute("data-settings-section-id"));
    expect(ids.slice(0, 4)).toEqual(["butler-model", "backup-models", "saved-keys", "permissions"]);
    const section = container.querySelector('[data-settings-section-id="saved-keys"]')!;
    expect(section.querySelector('[data-slot="form-section-header"] h3')?.textContent).toBe("API keys");
    const [openai, anthropic, google] = rows(container);
    expect(rows(container)).toHaveLength(3);
    expect(openai!.textContent).toContain("OpenAI");
    expect(openai!.textContent).toContain("sk-…enai");
    expect(openai!.textContent).toContain("2 models");
    expect(openai!.textContent).toContain("Stored only on this computer");
    expect(openai!.querySelector("svg")).not.toBeNull();
    expect(anthropic!.textContent).toContain("Anthropic");
    expect(google!.textContent).toContain("Not in use");
    // No key text beyond the masked value ever reaches the page.
    expect(container.textContent).not.toContain("sk-live");
  });
});

test("an agent without the key routes hides the section", async () => {
  const missing = () => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "not_found", status: 404 } });
  await render({ listCredentials: missing }, async ({ container }) => {
    expect(container.querySelector('[data-settings-section-id="saved-keys"]')).toBeNull();
    expect(container.querySelector('[data-settings-section-id="permissions"]')).not.toBeNull();
  });
});

test("a failed list shows the section error with Retry", async () => {
  let fail = true;
  const flaky = () => fail
    ? { ok: false, error: { schema: "butler.app.bridge-error.v1", code: "credential_file_failed", status: 500 } }
    : { credentials: KEYS, store: { backend: "fallback_file", reason: "unsigned_build" } };
  await render({ listCredentials: flaky }, async ({ container }) => {
    const section = container.querySelector<HTMLElement>('[data-settings-section-id="saved-keys"]')!;
    expect(section.querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    await click(button(section, en.settings.sectionState.retry));
    expect(rows(container)).toHaveLength(3);
  });
});

test("the section shows its empty line when no key is saved", async () => {
  await render({}, async ({ container }) => {
    expect(rows(container)).toHaveLength(0);
    expect(container.textContent).toContain(en.settings.savedKeys.empty);
  }, []);
});

test("storage labels: the local file (and unmigrated keys) stay local; system stores name the platform store", () => {
  const labels = en.settings.savedKeys.storage;
  expect(credentialStorageLabel("fallback_file", labels)).toBe("Stored only on this computer");
  expect(credentialStorageLabel("legacy_plaintext", labels)).toBe("Stored only on this computer");
  expect(credentialStorageLabel(undefined, labels)).toBe("Stored only on this computer");
  expect(credentialStorageLabel("keychain", labels)).toBe("Stored in Keychain");
  expect(credentialStorageLabel("secret_service", labels)).toBe("Stored in the system keyring");
  expect(credentialStorageLabel("credential_manager", labels)).toBe("Stored in Credential Manager");
  expect(credentialStorageLabel("fallback_file", ko.settings.savedKeys.storage)).toBe("이 컴퓨터에만 저장");
  expect(credentialStorageLabel("keychain", ko.settings.savedKeys.storage)).toBe("키체인에 저장");
});

test("the Korean rows read the local storage line and the model count", async () => {
  setAppCopyLanguage("ko");
  await render({}, async ({ container }) => {
    const [openai] = rows(container);
    expect(openai!.textContent).toContain("이 컴퓨터에만 저장");
    expect(openai!.textContent).toContain("모델 2개");
    expect(container.querySelector('[data-settings-section-id="saved-keys"] h3')?.textContent).toBe("API 키");
  });
});

test("replace verifies the new key first, then refreshes the keys and the model catalog", async () => {
  await render({ replaceCredential: () => ({ credential: KEYS[1] }) }, async (harness) => {
    const anthropic = rows(harness.container)[1]!;
    await openReplace(harness, anthropic, "sk-ant-new-key-123");
    const before = harness.calls.length;
    await click(button(anthropic, en.settings.savedKeys.save));
    expect(harness.calls.slice(before).map((call) => call.method)).toEqual(["replaceCredential", "listCredentials", "getModelCatalog"]);
    expect(harness.calls[before]!.input).toEqual({ name: "anthropic", request: { api_key: "sk-ant-new-key-123", verify: true } });
    expect(rows(harness.container)[1]!.querySelector("input")).toBeNull();
  });
});

test("replace shows a checking line while the key is verified", async () => {
  let release: (value: unknown) => void = () => undefined;
  await render({ replaceCredential: () => new Promise((resolve) => { release = resolve; }) }, async (harness) => {
    const openai = rows(harness.container)[0]!;
    const input = await openReplace(harness, openai, "sk-new-openai-key");
    await act(async () => input.dispatchEvent(new harness.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(openai.querySelector('[role="status"]')?.textContent).toContain(en.settings.savedKeys.checking);
    expect(button(openai, en.settings.savedKeys.save).disabled).toBe(true);
    await act(async () => release({ credential: KEYS[0] }));
    await settle();
  });
});

for (const [code, failure] of [
  ["invalid_key", "invalid"],
  ["no_access", "noaccess"],
  ["network", "network"],
  ["rate_limited", "ratelimited"],
  ["provider_unavailable", "unavailable"],
  ["credential_store_timeout", "savefailed"],
] as const) {
  test(`a replace refused with ${code} keeps the field open with the first-run message`, async () => {
    const refused = () => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code, status: 400 } });
    await render({ replaceCredential: refused }, async (harness) => {
      const openai = rows(harness.container)[0]!;
      const input = await openReplace(harness, openai, "sk-bad-openai-key");
      const before = harness.calls.length;
      await click(button(openai, en.settings.savedKeys.save));
      expect(openai.querySelector('[role="alert"]')?.textContent).toBe(en.firstRun.keyErrors[failure]);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.value).toBe("sk-bad-openai-key");
      expect(harness.calls.slice(before).map((call) => call.method)).toEqual(["replaceCredential"]);
    });
  });
}

test("Save stays off until the new key is long enough, and Cancel closes the field", async () => {
  await render({}, async (harness) => {
    const openai = rows(harness.container)[0]!;
    await openReplace(harness, openai, "short");
    expect(button(openai, en.settings.savedKeys.save).disabled).toBe(true);
    await click(button(openai, en.settings.savedKeys.cancel));
    expect(openai.querySelector("input")).toBeNull();
  });
});

test("delete rules: blocked for the default model's key, force with a count for other models, plain otherwise", () => {
  const defaults = ["openai/gpt-main"];
  expect(credentialDeleteRule(KEYS[0]!, defaults)).toEqual({ kind: "blocked" });
  expect(credentialDeleteRule(KEYS[1]!, defaults)).toEqual({ kind: "force", count: 2 });
  expect(credentialDeleteRule(KEYS[2]!, defaults)).toEqual({ kind: "plain" });
  // A default saved as a bare model id still matches its namespaced ref, like the agent's check.
  expect(credentialDeleteRule(key("x", "openai", ["openai/gpt-main"]), [" gpt-main "])).toEqual({ kind: "blocked" });
  expect(credentialDeleteRule(KEYS[1]!, ["", "openai/gpt-main"])).toEqual({ kind: "force", count: 2 });
});

test("the default model's key cannot be deleted and says to change the default model first", async () => {
  await render({}, async ({ container, calls }) => {
    const remove = button(rows(container)[0]!, en.settings.savedKeys.delete);
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute("aria-label")).toContain(en.settings.savedKeys.deleteDefaultHint);
    expect(calls.some((call) => call.method === "deleteCredential")).toBe(false);
  });
});

test("deleting a key other models use names how many are removed and deletes with force", async () => {
  await render({ deleteCredential: () => ({ credential: KEYS[1], removed_model_refs: KEYS[1]!.model_refs, secret_removed: true }) }, async (harness) => {
    const anthropic = rows(harness.container)[1]!;
    await act(async () => button(anthropic, en.settings.savedKeys.delete).click());
    const pending = useConfirmationStore.getState().pending!;
    expect(pending.message).toBe(en.settings.savedKeys.deleteConfirmModels("Anthropic", 2));
    expect(pending.destructive).toBe(true);
    const before = harness.calls.length;
    await act(async () => pending.resolve(true));
    await settle();
    expect(harness.calls.slice(before).map((call) => call.method)).toEqual(["deleteCredential", "listCredentials", "getModelCatalog"]);
    expect(harness.calls[before]!.input).toEqual({ name: "anthropic", force: true });
  });
});

test("deleting an unused key asks plainly and deletes without force; cancelling sends nothing", async () => {
  await render({ deleteCredential: () => ({ credential: KEYS[2], removed_model_refs: [], secret_removed: true }) }, async (harness) => {
    const google = rows(harness.container)[2]!;
    await act(async () => button(google, en.settings.savedKeys.delete).click());
    expect(useConfirmationStore.getState().pending!.message).toBe(en.settings.savedKeys.deleteConfirm("Google"));
    await act(async () => useConfirmationStore.getState().pending!.resolve(false));
    await settle();
    expect(harness.calls.some((call) => call.method === "deleteCredential")).toBe(false);

    await act(async () => button(google, en.settings.savedKeys.delete).click());
    await act(async () => useConfirmationStore.getState().pending!.resolve(true));
    await settle();
    expect(harness.calls.find((call) => call.method === "deleteCredential")!.input).toEqual({ name: "google", force: false });
  });
});

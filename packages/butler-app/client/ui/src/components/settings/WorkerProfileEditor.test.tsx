/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  AppModelSummary,
  ModelCatalogView,
  ReasoningEffort,
  SettingsView,
  WorkerProfile,
} from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { ModelsSettings } from "./ModelsSettings";
import {
  WORKER_PROFILE_BUILTIN_JOBS,
  commitWorkerProfileCustomJob,
  selectWorkerProfileJob,
  selectWorkerProfileModel,
} from "./workerProfileUpdates";

function model(
  modelRef: string,
  displayName: string,
  efforts: ReasoningEffort[],
  defaultEffort: ReasoningEffort,
): AppModelSummary {
  const [providerId, modelId] = modelRef.split("/");
  return {
    provider_id: providerId ?? "openai",
    provider_label: "OpenAI",
    model_id: modelId ?? modelRef,
    model_ref: modelRef,
    display_name: displayName,
    status: "available",
    default_reasoning_effort: defaultEffort,
    reasoning_efforts: efforts,
    token_estimator: "character_estimate",
    runtime_supported: true,
  };
}

const m1 = model("openai/m1", "M1 mini", ["none", "low", "medium"], "medium");
const m2 = model("openai/m2", "M2 large", ["medium", "high"], "high");
const localBudgeted = {
  ...model("local/lm", "LM", ["none", "low"], "low"),
  provider_id: "local",
  provider_label: "Local",
  local_reasoning_budget_ratio: 0.25,
};
const localPlain = {
  ...model("local/lm", "LM", ["none", "low"], "low"),
  provider_id: "local",
  provider_label: "Local",
};

const catalog: ModelCatalogView = {
  ...EMPTY_MODEL_CATALOG,
  registered_models: [m1, m2],
};

const defaultProfile: WorkerProfile = {
  id: "default",
  label: "Default",
  enabled: true,
  job: { kind: "builtin", job: "coding" },
  model: "openai/m1",
  reasoning_effort: "medium",
};

const researchProfile: WorkerProfile = {
  id: "research-1",
  label: "Research",
  enabled: true,
  job: { kind: "builtin", job: "research" },
  model: "openai/m1",
  reasoning_effort: "low",
};

const customResearchProfile: WorkerProfile = {
  ...researchProfile,
  job: { kind: "custom", text: "Legacy audit" },
};

const deferredResearchProfile: WorkerProfile = {
  ...researchProfile,
  job: { kind: "custom", text: "Threat hunting" },
  domain: "cloud",
  prompt: "Hunt anomalies.",
};

function seedSettings(
  research: WorkerProfile = researchProfile,
): SettingsView {
  return { ...EMPTY_SETTINGS, worker_profiles: [defaultProfile, research] };
}

const initialUIState = useSettingsUIStore.getState();
const initialButlerState = useButlerStore.getState();

let dom: JSDOM | undefined;
let root: Root | undefined;

const INSTALLED_GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "Event",
  "FocusEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

function installDom(): JSDOM {
  const installed = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
  });
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(installed.window, { requestAnimationFrame, cancelAnimationFrame });
  const globals: Record<string, unknown> = {
    window: installed.window,
    document: installed.window.document,
    navigator: installed.window.navigator,
    Element: installed.window.Element,
    HTMLElement: installed.window.HTMLElement,
    HTMLInputElement: installed.window.HTMLInputElement,
    Node: installed.window.Node,
    Event: installed.window.Event,
    FocusEvent: installed.window.FocusEvent,
    getComputedStyle: installed.window.getComputedStyle.bind(installed.window),
    requestAnimationFrame,
    cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(globalThis, globals);
  return installed;
}

async function renderApp(): Promise<void> {
  const container = dom!.window.document.querySelector("#root");
  if (!(container instanceof dom!.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  await act(async () => root?.render(<ModelsSettings />));
}

interface BridgeDouble {
  patches: Array<Record<string, unknown>>;
  applied: SettingsView[];
}

function installBridgeAndStores(seed: SettingsView): BridgeDouble {
  const patches: Array<Record<string, unknown>> = [];
  const applied: SettingsView[] = [];
  let persisted = seed;
  dom!.window.butlerApp = {
    updateSettings: async (patch?: Partial<SettingsView>) => {
      patches.push(patch ?? {});
      persisted = { ...persisted, ...(patch ?? {}) };
      return persisted;
    },
  };
  useSettingsUIStore.setState({ draft: seed, modelRoute: { page: "root" } });
  useButlerStore.setState({
    modelCatalog: catalog,
    setSettings: (settings: SettingsView) => {
      applied.push(settings);
    },
  });
  return { patches, applied };
}

async function typeAndBlur(element: Element, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      dom!.window.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new dom!.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    element.dispatchEvent(
      new dom!.window.FocusEvent("focusout", { bubbles: true }),
    );
  });
}

async function clickSwitch(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function fieldByLabel(panel: Element, label: string): HTMLElement | undefined {
  return Array.from(
    panel.querySelectorAll<HTMLElement>('[data-test-class="settings-field"]'),
  ).find((field) => field.querySelector("label")?.textContent === label);
}

function fieldInput(panel: Element, label: string): Element {
  const input = fieldByLabel(panel, label)?.querySelector("input");
  if (!input) throw new Error(`Missing input for field: ${label}`);
  return input;
}

function workerPanels(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-test-class="worker-profile"]',
    ),
  );
}

function buttonByTestClass(testClass: string): HTMLElement {
  const button = document.querySelector<HTMLElement>(
    `button[data-test-class="${testClass}"]`,
  );
  if (!button) throw new Error(`Missing button: ${testClass}`);
  return button;
}

function comboboxText(panel: Element, label: string): string {
  const trigger = fieldByLabel(panel, label)?.querySelector(
    '[role="combobox"]',
  );
  if (!trigger) throw new Error(`Missing combobox for field: ${label}`);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  return trigger.textContent ?? "";
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  dom = undefined;
  useSettingsUIStore.setState(initialUIState);
  useButlerStore.setState(initialButlerState);
  for (const key of INSTALLED_GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

test("existing profiles persist canonical worker_profiles patches through the bridge", async () => {
  dom = installDom();
  const { patches, applied } = installBridgeAndStores(seedSettings());
  await renderApp();

  expect(document.body.textContent ?? "").toContain("Worker profiles");
  const panels = workerPanels();
  expect(panels.length).toBe(2);
  expect(panels[0]!.textContent ?? "").toContain("Default");
  expect(panels[1]!.textContent ?? "").toContain("Research");

  const defaultSwitch = panels[0]!.querySelector('[data-slot="switch"]')!;
  expect(defaultSwitch.hasAttribute("disabled")).toBe(true);
  await clickSwitch(defaultSwitch);
  expect(patches.length).toBe(0);

  const research = panels[1]!;
  await typeAndBlur(fieldInput(research, "Name"), "Deep Research");
  await typeAndBlur(fieldInput(research, "Domain"), " security ");
  await typeAndBlur(fieldInput(research, "Worker prompt"), "Focus on CVEs.");

  const afterLabel = { ...researchProfile, label: "Deep Research" };
  const afterDomain = { ...afterLabel, domain: "security" };
  const afterPrompt = { ...afterDomain, prompt: "Focus on CVEs." };
  expect(patches[0]).toEqual({
    worker_profiles: [defaultProfile, afterLabel],
  });
  expect(patches[1]).toEqual({
    worker_profiles: [defaultProfile, afterDomain],
  });
  expect(patches.length).toBe(3);

  const enabledSwitch = fieldByLabel(research, "Enabled")!.querySelector(
    '[data-slot="switch"]',
  )!;
  expect(enabledSwitch.hasAttribute("disabled")).toBe(false);
  await clickSwitch(enabledSwitch);

  const afterToggle = { ...afterPrompt, enabled: false };
  expect(patches.length).toBe(4);
  expect(patches[3]).toEqual({
    worker_profiles: [defaultProfile, afterToggle],
  });

  for (const patch of patches) {
    expect(Object.keys(patch)).toEqual(["worker_profiles"]);
    const profiles = patch.worker_profiles as WorkerProfile[];
    expect(profiles.map((profile) => profile.id)).toEqual([
      "default",
      "research-1",
    ]);
  }
  expect(applied.at(-1)?.worker_profiles).toEqual([defaultProfile, afterToggle]);
  expect(JSON.stringify(patches)).not.toContain("worker_model_rules");

  expect(comboboxText(research, "Job")).toContain("Research");
  expect(comboboxText(research, "Model")).toContain("OpenAI / M1 mini");
  expect(comboboxText(research, "Reasoning")).toContain("Low");
});

test("custom job selection keeps the shared profile valid until bounded text commits", async () => {
  dom = installDom();
  const { patches } = installBridgeAndStores(seedSettings(customResearchProfile));
  await renderApp();

  const panels = workerPanels();
  expect(panels.length).toBe(2);
  const customPanel = panels[1]!;
  expect(comboboxText(customPanel, "Job")).toContain("Custom");

  const customInput = fieldInput(customPanel, "Custom job");
  await typeAndBlur(customInput, "   ");
  expect(patches.length).toBe(0);

  await typeAndBlur(
    customInput,
    "x".repeat(161),
  );
  expect(patches.length).toBe(0);

  await clickSwitch(
    fieldByLabel(customPanel, "Enabled")!.querySelector('[data-slot="switch"]')!,
  );
  expect(patches.length).toBe(1);
  expect(patches[0]).toEqual({
    worker_profiles: [
      defaultProfile,
      { ...customResearchProfile, enabled: false },
    ],
  });
  expect(JSON.stringify(patches[0])).not.toContain('"text":""');

  await typeAndBlur(customInput, "  Security audit  ");
  expect(patches.length).toBe(2);
  expect(patches[1]).toEqual({
    worker_profiles: [
      defaultProfile,
      {
        ...customResearchProfile,
        enabled: false,
        job: { kind: "custom", text: "Security audit" },
      },
    ],
  });
});

test("unchanged valid blurs stay silent while one genuine field change emits a canonical patch", async () => {
  dom = installDom();
  const { patches } = installBridgeAndStores(
    seedSettings(deferredResearchProfile),
  );
  await renderApp();

  const panels = workerPanels();
  expect(panels.length).toBe(2);
  const research = panels[1]!;
  await typeAndBlur(fieldInput(research, "Custom job"), "Threat hunting");
  await typeAndBlur(fieldInput(research, "Domain"), "cloud");
  await typeAndBlur(fieldInput(research, "Worker prompt"), "Hunt anomalies.");
  expect(patches.length).toBe(0);

  await typeAndBlur(fieldInput(research, "Domain"), "identity");
  expect(patches.length).toBe(1);
  expect(patches[0]).toEqual({
    worker_profiles: [
      defaultProfile,
      { ...deferredResearchProfile, domain: "identity" },
    ],
  });
  expect(
    (patches[0]!.worker_profiles as WorkerProfile[]).map(
      (profile) => profile.id,
    ),
  ).toEqual(["default", "research-1"]);
  expect(JSON.stringify(patches)).not.toContain("worker_model_rules");
});

test("unchanged empty optional domain and prompt blurs emit zero patches", async () => {
  dom = installDom();
  const { patches } = installBridgeAndStores(seedSettings());
  await renderApp();

  const panels = workerPanels();
  expect(panels.length).toBe(2);
  const research = panels[1]!;
  const domainInput = fieldInput(research, "Domain");
  const promptInput = fieldInput(research, "Worker prompt");

  await typeAndBlur(domainInput, "");
  await typeAndBlur(domainInput, "   ");
  await typeAndBlur(promptInput, "");
  await typeAndBlur(promptInput, "   ");
  expect(patches.length).toBe(0);
  expect((domainInput as HTMLInputElement).value).toBe("");
  expect((promptInput as HTMLInputElement).value).toBe("");

  await typeAndBlur(domainInput, " security ");
  expect(patches.length).toBe(1);
  expect(patches[0]).toEqual({
    worker_profiles: [
      defaultProfile,
      { ...researchProfile, domain: "security" },
    ],
  });
});

test("add, delete, and max-workers controls persist canonical patches through the bridge", async () => {
  dom = installDom();
  const { patches } = installBridgeAndStores(seedSettings());
  await renderApp();

  const createdProfile: WorkerProfile = {
    id: "worker-1",
    label: "Worker 1",
    enabled: true,
    job: { kind: "builtin", job: "coding" },
    model: defaultProfile.model,
    reasoning_effort: defaultProfile.reasoning_effort,
  };

  await act(async () => buttonByTestClass("worker-profile-add").click());
  expect(patches.length).toBe(1);
  expect(Object.keys(patches[0]!)).toEqual(["worker_profiles"]);
  expect(patches[0]!.worker_profiles).toEqual([
    defaultProfile,
    researchProfile,
    createdProfile,
  ]);
  expect(/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(createdProfile.id)).toBe(true);

  const panelsAfterAdd = workerPanels();
  expect(panelsAfterAdd.length).toBe(3);
  const createdPanel = panelsAfterAdd[2]!;
  expect(
    createdPanel.querySelector('[data-test-class="worker-profile-delete"]'),
  ).toBeTruthy();
  const defaultPanel = panelsAfterAdd[0]!;
  expect(defaultPanel.textContent ?? "").toContain("Default");
  expect(
    defaultPanel.querySelector('[data-test-class="worker-profile-delete"]'),
  ).toBeNull();
  expect(
    defaultPanel.querySelector('[data-slot="switch"]')!.hasAttribute("disabled"),
  ).toBe(true);

  await act(async () =>
    createdPanel
      .querySelector<HTMLElement>('[data-test-class="worker-profile-delete"]')!
      .click(),
  );
  expect(patches.length).toBe(2);
  expect(Object.keys(patches[1]!)).toEqual(["worker_profiles"]);
  expect(
    (patches[1]!.worker_profiles as WorkerProfile[]).map((profile) => profile.id),
  ).toEqual(["default", "research-1"]);

  const maxInput = fieldInput(document.body, "Max simultaneous Workers");
  expect((maxInput as HTMLInputElement).value).toBe("10");
  await typeAndBlur(maxInput, "6");
  expect(patches.length).toBe(3);
  expect(Object.keys(patches[2]!)).toEqual(["max_simultaneous_workers"]);
  expect(patches[2]!.max_simultaneous_workers).toBe(6);

  for (const invalid of ["", "0", "11", "6.5"]) {
    await typeAndBlur(maxInput, invalid);
    expect((maxInput as HTMLInputElement).value).toBe("6");
  }
  expect(patches.length).toBe(3);

  for (const patch of patches) {
    expect(JSON.stringify(patch)).not.toContain("worker_model_rules");
  }
});

test("add allocates worker id and label independently across crossed occupancy", async () => {
  dom = installDom();
  const crossedA: WorkerProfile = {
    ...defaultProfile,
    id: "worker-1",
    label: "Worker 2",
  };
  const crossedB: WorkerProfile = {
    ...defaultProfile,
    id: "worker-3",
    label: "Worker 1",
  };
  const { patches } = installBridgeAndStores({
    ...EMPTY_SETTINGS,
    worker_profiles: [defaultProfile, crossedA, crossedB],
  });
  await renderApp();

  await act(async () => buttonByTestClass("worker-profile-add").click());

  expect(patches.length).toBe(1);
  expect(Object.keys(patches[0]!)).toEqual(["worker_profiles"]);
  expect(patches[0]!.worker_profiles).toEqual([
    defaultProfile,
    crossedA,
    crossedB,
    {
      id: "worker-2",
      label: "Worker 3",
      enabled: true,
      job: { kind: "builtin", job: "coding" },
      model: defaultProfile.model,
      reasoning_effort: defaultProfile.reasoning_effort,
    },
  ]);
  expect(JSON.stringify(patches[0])).not.toContain("worker_model_rules");
});

test("transition helpers cover job selection and model reasoning rules", () => {
  for (const job of WORKER_PROFILE_BUILTIN_JOBS) {
    expect(selectWorkerProfileJob(job)).toEqual({
      persistent: true,
      job: { kind: "builtin", job },
    });
  }
  expect(selectWorkerProfileJob("custom")).toEqual({ persistent: false });
  expect(selectWorkerProfileJob("unknown")).toBeNull();

  expect(commitWorkerProfileCustomJob("   ")).toBeNull();
  expect(commitWorkerProfileCustomJob("")).toBeNull();
  expect(commitWorkerProfileCustomJob("a".repeat(161))).toBeNull();
  expect(commitWorkerProfileCustomJob("a".repeat(160))).toEqual({
    kind: "custom",
    text: "a".repeat(160),
  });
  expect(commitWorkerProfileCustomJob("  Security audit  ")).toEqual({
    kind: "custom",
    text: "Security audit",
  });

  expect(selectWorkerProfileModel([m1], m1.model_ref, "low")).toEqual({
    model: m1.model_ref,
    reasoning_effort: "low",
  });
  expect(selectWorkerProfileModel([m1], m1.model_ref, "none")).toEqual({
    model: m1.model_ref,
    reasoning_effort: "none",
  });
  expect(selectWorkerProfileModel([m2], m2.model_ref, "medium")).toEqual({
    model: m2.model_ref,
    reasoning_effort: "medium",
  });
  expect(selectWorkerProfileModel([m2], m2.model_ref, "low")).toEqual({
    model: m2.model_ref,
    reasoning_effort: "high",
  });
  expect(selectWorkerProfileModel([localBudgeted], localBudgeted.model_ref, "none")).toEqual({
    model: localBudgeted.model_ref,
    reasoning_effort: "low",
  });
  expect(selectWorkerProfileModel([localPlain], localPlain.model_ref, "none")).toEqual({
    model: localPlain.model_ref,
    reasoning_effort: "none",
  });
});

function installDeferredBridgeAndStores(
  seed: SettingsView,
): { patches: Array<Record<string, unknown>>; resolveFirst: () => void } {
  const patches: Array<Record<string, unknown>> = [];
  let persisted = seed;
  let releaseFirst!: () => void;
  const firstPatchGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstPending = true;
  dom!.window.butlerApp = {
    updateSettings: async (patch?: Partial<SettingsView>) => {
      patches.push(patch ?? {});
      if (firstPending) {
        firstPending = false;
        await firstPatchGate;
      }
      persisted = { ...persisted, ...(patch ?? {}) };
      return persisted;
    },
  };
  useSettingsUIStore.setState({ draft: seed, modelRoute: { page: "root" } });
  useButlerStore.setState({
    modelCatalog: catalog,
    setSettings: (_settings: SettingsView) => {},
  });
  return { patches, resolveFirst: releaseFirst };
}

test("pending save disables worker controls until the bridge resolves", async () => {
  dom = installDom();
  const { patches, resolveFirst } = installDeferredBridgeAndStores(
    seedSettings(customResearchProfile),
  );
  await renderApp();

  const panels = workerPanels();
  expect(panels.length).toBe(2);
  const research = panels[1]!;
  await typeAndBlur(fieldInput(research, "Name"), "Deep Research");
  expect(patches.length).toBe(1);
  expect(useSettingsUIStore.getState().saving).toBe(true);

  const deleteButton = research.querySelector<HTMLElement>(
    '[data-test-class="worker-profile-delete"]',
  )!;
  const maxInput = fieldInput(document.body, "Max simultaneous Workers");
  const enabledSwitch = fieldByLabel(research, "Enabled")!.querySelector(
    '[data-slot="switch"]',
  )!;
  expect(buttonByTestClass("worker-profile-add").hasAttribute("disabled")).toBe(true);
  expect(deleteButton.hasAttribute("disabled")).toBe(true);
  expect(maxInput.hasAttribute("disabled")).toBe(true);
  expect(fieldInput(research, "Name").hasAttribute("disabled")).toBe(true);
  expect(enabledSwitch.hasAttribute("disabled")).toBe(true);
  expect(
    fieldByLabel(research, "Job")!.querySelector('[role="combobox"]')!
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    fieldByLabel(research, "Model")!.querySelector('[role="combobox"]')!
      .hasAttribute("disabled"),
  ).toBe(true);
  const defaultSwitch = panels[0]!.querySelector('[data-slot="switch"]')!;
  expect(defaultSwitch.hasAttribute("disabled")).toBe(true);

  await act(async () => {
    buttonByTestClass("worker-profile-add").click();
    deleteButton.click();
  });
  expect(patches.length).toBe(1);

  await act(async () => {
    resolveFirst();
    await Promise.resolve();
  });

  expect(useSettingsUIStore.getState().saving).toBe(false);
  expect(buttonByTestClass("worker-profile-add").hasAttribute("disabled")).toBe(false);
  expect(deleteButton.hasAttribute("disabled")).toBe(false);
  expect(fieldInput(research, "Name").hasAttribute("disabled")).toBe(false);
  const reEnabledSwitch = fieldByLabel(research, "Enabled")!.querySelector(
    '[data-slot="switch"]',
  )!;
  expect(reEnabledSwitch.hasAttribute("disabled")).toBe(false);
  expect(defaultSwitch.hasAttribute("disabled")).toBe(true);

  await clickSwitch(reEnabledSwitch);
  expect(patches.length).toBe(2);
  expect(Object.keys(patches[1]!)).toEqual(["worker_profiles"]);
  expect(JSON.stringify(patches)).not.toContain("worker_model_rules");
});

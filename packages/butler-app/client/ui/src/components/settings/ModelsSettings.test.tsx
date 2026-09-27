/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { ButlerModelSettings } from "./ButlerModelSettings";
import { ModelsSettings } from "./ModelsSettings";

const initialUIState = useSettingsUIStore.getState();
const initialButlerState = useButlerStore.getState();
afterEach(() => {
  useSettingsUIStore.setState(initialUIState, true);
  useButlerStore.setState(initialButlerState, true);
  setAppCopyLanguage("en");
});

function model(ref: string, name: string): AppModelSummary {
  return {
    model_ref: ref,
    display_name: name,
    model_id: ref,
    provider_id: "custom",
    registered: true,
    runtime_supported: true,
    reasoning_efforts: ["none"],
    default_reasoning_effort: "none",
  } as unknown as AppModelSummary;
}

const MODELS = [model("custom/main", "Main"), model("custom/mini", "Mini"), model("custom/spare", "Spare")];

async function render(node: ReactNode, settings: Partial<SettingsView>, run: (container: HTMLElement) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  Object.assign(dom.window, { requestAnimationFrame, cancelAnimationFrame, ResizeObserver, matchMedia });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame, cancelAnimationFrame, ResizeObserver, matchMedia,
    fetch: () => new Promise<Response>(() => undefined), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  useSettingsUIStore.setState({
    draft: { ...EMPTY_SETTINGS, model: "custom/main", ...settings },
    modelRoute: { page: "root" },
  });
  useButlerStore.setState({
    modelCatalog: { ...EMPTY_MODEL_CATALOG, models: MODELS, registered_models: MODELS },
  });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(node));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

const sectionIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-settings-section-id]")).map((section) =>
    section.getAttribute("data-settings-section-id"));
const settingIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-setting-id]")).map((field) => field.getAttribute("data-setting-id"));

test("the Models page keeps backup models visible and folds cleanup and workers into Advanced", async () => {
  await render(<ModelsSettings />, {}, async (container) => {
    expect(sectionIds(container)).toEqual(["butler-model", "backup-models", "permissions", "advanced-models"]);
    // Like every section, Advanced has its header outside the card; the card holds the disclosure row.
    const section = container.querySelector('[data-settings-section-id="advanced-models"]')!;
    expect(section.querySelector('[data-slot="form-section-header"] h3')?.textContent).toBe("Advanced");
    const advanced = section.querySelector<HTMLElement>('[data-slot="form-section-card"] [aria-expanded]')!;
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(advanced.textContent).toBe("Memory cleanup model and worker profiles");

    await act(async () => advanced.click());
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(sectionIds(container)).toEqual([
      "butler-model", "backup-models", "permissions", "advanced-models", "memory-cleanup", "worker-profiles",
    ]);
    expect(settingIds(container)).toContain("consolidation-model");
  });
});

test("backup models show a one-line summary and open the editor on Edit", async () => {
  await render(<ModelsSettings />, {}, async (container) => {
    const section = container.querySelector<HTMLElement>('[data-settings-section-id="backup-models"]')!;
    expect(section.querySelector('[data-setting-id="backup-models-summary"]')?.textContent).toContain("Off");
    expect(section.querySelector('[data-setting-id="backup-models-enabled"]')).toBeNull();

    const edit = Array.from(section.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Edit")!;
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    await act(async () => edit.click());
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    expect(edit.textContent).toBe("Done");
    expect(section.querySelector('[data-setting-id="backup-models-enabled"]')).not.toBeNull();
  });
});

test("the backup summary names the models in order when backups are on", async () => {
  const on = { model_fallback: { enabled: true, models: ["custom/spare", "custom/mini"] } };
  await render(<ModelsSettings />, on, async (container) => {
    const summary = container.querySelector('[data-setting-id="backup-models-summary"]')?.textContent ?? "";
    expect(summary).toContain("Spare → Mini");
    expect(summary).not.toContain("Off");
  });
  await render(<ModelsSettings />, { model_fallback: { enabled: true, models: [] } }, async (container) => {
    expect(container.querySelector('[data-setting-id="backup-models-summary"]')?.textContent).toContain("No backup models");
  });
});

test("first run shows the main model, the backup summary and permissions only", async () => {
  await render(<ButlerModelSettings />, {}, async (container) => {
    expect(sectionIds(container)).toEqual(["butler-model", "backup-models", "permissions"]);
    expect(settingIds(container)).not.toContain("consolidation-model");
  });
});

test("the Korean Models page names the disclosure 고급", async () => {
  setAppCopyLanguage("ko");
  await render(<ModelsSettings />, {}, async (container) => {
    const section = container.querySelector('[data-settings-section-id="advanced-models"]');
    expect(section?.querySelector('[data-slot="form-section-header"] h3')?.textContent).toBe("고급");
    expect(container.querySelector('[data-setting-id="backup-models-summary"]')?.textContent).toContain("사용 안 함");
  });
});

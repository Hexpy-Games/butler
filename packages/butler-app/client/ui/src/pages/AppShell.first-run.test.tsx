/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { FIRST_RUN_TEST_MODEL } from "@/app/fixtures.ts";
import {
  createInitialFirstRunState,
  FIRST_RUN_STORAGE_KEY,
} from "@/app/firstRunSetup.ts";
import type {
  AppModelSummary,
  ModelCatalogView,
  ProviderAuthMethod,
  SettingsView,
} from "@/app/types.ts";

interface TestStoreState {
  activeChatId: string;
  commandOpen: boolean;
  effectiveRightOpen: boolean;
  isSettingsView: boolean;
  leftOpen: boolean;
  openSettingsCalls: string[];
  renameProject: null;
  renameSession: null;
  resizingPanel: null;
  rightAvailable: boolean;
  modelCatalog: ModelCatalogView;
  setModelCatalog: (catalog: ModelCatalogView) => void;
  setSettings: (settings: SettingsView) => void;
  settings: SettingsView & { sidebar_style?: "translucent" };
  view: { kind: "session" };
}

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const storeState: TestStoreState = {
  activeChatId: "session-shell",
  commandOpen: false,
  effectiveRightOpen: false,
  isSettingsView: false,
  leftOpen: true,
  openSettingsCalls: [],
  renameProject: null,
  renameSession: null,
  resizingPanel: null,
  rightAvailable: false,
  modelCatalog: EMPTY_MODEL_CATALOG,
  setModelCatalog: (catalog) => {
    storeState.modelCatalog = catalog;
    emitStoreChange();
  },
  setSettings: (settings) => {
    storeState.settings = { ...settings, sidebar_style: "translucent" };
    emitStoreChange();
  },
  settings: { ...EMPTY_SETTINGS, sidebar_style: "translucent" },
  view: { kind: "session" },
};

const storeListeners = new Set<() => void>();
let cachedStoreSnapshot: TestStoreState | null = null;

mock.module("@/components/layout/Chrome.tsx", () => ({
  WindowChromeLayer: () => <div data-test-class="chrome-layer" />,
}));
mock.module("@/components/layout/RightPanelOverlayTitlebar.tsx", () => ({
  RightPanelOverlayTitlebar: () => <div />,
}));
mock.module("@/components/layout/Sidebar.tsx", () => ({
  Sidebar: () => <aside>Sidebar</aside>,
}));
mock.module("@/components/layout/Titlebar.tsx", () => ({
  Titlebar: () => <header>Titlebar</header>,
}));
mock.module("@/components/conversation/Conversation.tsx", () => ({
  Conversation: () => <div data-test-class="workspace-ready">Workspace</div>,
}));
mock.module("@/components/inspector/Inspector.tsx", () => ({
  Inspector: () => <div />,
}));
mock.module("@/components/management/ProjectDashboardView.tsx", () => ({
  ProjectDashboardView: () => <div />,
}));
mock.module("@/components/management/AutomationsView.tsx", () => ({
  AutomationsView: () => <div />,
}));
mock.module("@/components/settings/SettingsView.tsx", () => ({
  SettingsView: () => <div data-test-class="settings-models">Settings</div>,
}));
mock.module("@/components/command/CommandPalette.tsx", () => ({
  CommandPalette: () => <div />,
}));
mock.module("@/components/layout/ProjectRenameDialog.tsx", () => ({
  ProjectRenameDialog: () => <div />,
}));
mock.module("@/components/layout/SessionRenameDialog.tsx", () => ({
  SessionRenameDialog: () => <div />,
}));
mock.module("@/components/common/AppToaster.tsx", () => ({
  AppToaster: () => <div />,
}));
mock.module("@/hooks/useAppBootstrap.ts", () => ({
  useAppBootstrap: () => undefined,
}));
mock.module("@/hooks/useNativeAppearanceTheme.ts", () => ({
  useNativeAppearanceTheme: () => undefined,
}));
mock.module("@/hooks/useNativeShellPreferences.ts", () => ({
  useNativeShellPreferences: () => undefined,
}));
mock.module("@/hooks/usePortalThemeClasses.ts", () => ({
  usePortalThemeClasses: () => undefined,
}));
mock.module("@/hooks/useSystemThemePreference.ts", () => ({
  useSystemThemePreference: () => false,
}));
mock.module("@/hooks/useNarrowRightPanelAutoCollapse.ts", () => ({
  useNarrowRightPanelAutoCollapse: () => undefined,
}));
mock.module("@/hooks/usePanelResize.ts", () => ({
  LEFT_PANEL_MAX_WIDTH: 480,
  LEFT_PANEL_MIN_WIDTH: 240,
  RIGHT_PANEL_MAX_WIDTH: 560,
  RIGHT_PANEL_MIN_WIDTH: 280,
  usePanelResize: () => ({
    beginPanelResize: () => undefined,
    handlePanelResizeKeyDown: () => undefined,
    leftPanelWidth: 304,
    panelStyle: {},
    rightPanelWidth: 376,
    resizingPanel: null,
  }),
}));
mock.module("@/app/store.ts", () => ({
  selectEffectiveRightOpen: (state: TestStoreState) => state.effectiveRightOpen,
  selectIsSettingsView: (state: TestStoreState) => state.isSettingsView,
  selectRightAvailable: (state: TestStoreState) => state.rightAvailable,
  useButlerStore,
}));

function useButlerStore<T>(selector: (state: TestStoreState) => T): T {
  return React.useSyncExternalStore(
    subscribeToTestStore,
    () => selector(testStoreSnapshot()),
    () => selector(testStoreSnapshot()),
  );
}

useButlerStore.getState = testStoreSnapshot;

function subscribeToTestStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function emitStoreChange() {
  cachedStoreSnapshot = null;
  for (const listener of storeListeners) listener();
}

function testStoreSnapshot(): TestStoreState {
  if (cachedStoreSnapshot) return cachedStoreSnapshot;
  cachedStoreSnapshot = {
    ...storeState,
    openSettings(section = "general") {
      storeState.openSettingsCalls.push(String(section));
      storeState.isSettingsView = true;
      emitStoreChange();
    },
    setLeftOpen() {},
  } as TestStoreState;
  return cachedStoreSnapshot;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
  storeState.isSettingsView = false;
  storeState.openSettingsCalls = [];
  storeState.modelCatalog = EMPTY_MODEL_CATALOG;
  storeState.settings = { ...EMPTY_SETTINGS, sidebar_style: "translucent" };
  storeListeners.clear();
  cachedStoreSnapshot = null;
});

test("AppShell gates workspace behind pending first-run setup", async () => {
  const rendered = await renderAppShell({
    [FIRST_RUN_STORAGE_KEY]: JSON.stringify(createInitialFirstRunState("ko")),
  });

  expect(rendered.container.textContent).toContain("언어 선택");
  expect(rendered.container.textContent).not.toContain("Workspace");
  expect(
    rendered.container.querySelector('[data-test-class="app-window-controls"]'),
  ).not.toBeNull();
  expect(
    rendered.container.querySelector('[data-test-class="app-window-minimize"]'),
  ).not.toBeNull();
  expect(
    rendered.container.querySelector('[data-test-class="app-window-maximize"]'),
  ).not.toBeNull();
  expect(
    rendered.container.querySelector('[data-test-class="app-window-close"]'),
  ).not.toBeNull();

  await clickButton(rendered.container, "계속");
  await clickButton(rendered.container, "동의");
  await waitForText(rendered.container, "모델 설정");
  await addHostedModelAndFinish(rendered.container);

  expect(rendered.container.textContent).toContain("Workspace");
  expect(storeState.openSettingsCalls).toEqual([]);

  await act(async () => rendered.root.unmount());
});

test("AppShell keeps model setup inside first-run wizard", async () => {
  const rendered = await renderAppShell({
    [FIRST_RUN_STORAGE_KEY]: JSON.stringify(createInitialFirstRunState("ko")),
  });

  await clickButton(rendered.container, "계속");
  await clickButton(rendered.container, "동의");
  await waitForText(rendered.container, "모델 설정");
  expect(rendered.container.textContent).not.toContain("모델 설정 열기");
  await addHostedModelAndFinish(rendered.container);

  expect(storeState.openSettingsCalls).toEqual([]);
  expect(rendered.container.textContent).toContain("Workspace");

  await act(async () => rendered.root.unmount());
});

async function renderAppShell(
  storageValues: Record<string, string>,
): Promise<{ container: HTMLElement; root: Root }> {
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

  Object.entries(storageValues).forEach(([key, value]) => {
    dom.window.localStorage.setItem(key, value);
  });
  const authMethods: ProviderAuthMethod[] = ["api_key", "codex_oauth"];
  Object.assign(dom.window, {
    butlerApp: {
      startSetup: async () => ({
        diagnostics_available: true,
        phase: "ready",
        status_label: "준비 완료",
      }),
      getModelCatalog: async () => ({
        ...EMPTY_MODEL_CATALOG,
        providers: [
          {
            provider_id: "openai",
            provider_label: "OpenAI",
            latest_model_ref: FIRST_RUN_TEST_MODEL.model_ref,
            auth_methods: authMethods,
            models: [FIRST_RUN_TEST_MODEL],
          },
        ],
        provider_credentials: [
          {
            id: "cred-existing",
            provider_id: "openai",
            label: "Existing key",
            masked_value: "sk-...",
            auth_type: "api_key",
            created_at: "2026-06-13T00:00:00.000Z",
            updated_at: "2026-06-13T00:00:00.000Z",
          },
        ],
        registered_models: [],
      }),
      getSettings: async () => EMPTY_SETTINGS,
      registerHostedModel: async () => {
        const catalog = firstRunRegisteredModelCatalog();
        return {
          model: catalog.registered_models?.[0],
          catalog,
        };
      },
      updateSettings: async () => ({}),
      platform: "win32",
      minimizeWindow: async () => ({}),
      toggleWindowMaximize: async () => ({}),
      closeWindow: async () => ({}),
    },
  });

  const { AppShell } = await import("./AppShell");
  const container = dom.window.document.getElementById("root");
  if (!container) throw new Error("Missing test root");
  const root = createRoot(container);
  await act(async () => {
    root.render(<AppShell />);
  });
  return { container, root };
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

async function addHostedModelAndFinish(container: HTMLElement): Promise<void> {
  await waitForText(container, "API key");
  expect(buttonByLabel(container, "저장하고 시작")).toBeUndefined();
  await clickButton(container, "추가");
  await waitForText(container, "Workspace");
}

function buttonByLabel(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

function firstRunRegisteredModelCatalog(): ModelCatalogView {
  const defaultModel: AppModelSummary = {
    ...FIRST_RUN_TEST_MODEL,
    registered: true,
    auth_type: "api_key",
    credential_id: "cred-test",
    credential_label: "Test key",
    credential_masked_value: "sk-...",
  };
  const authMethods: ProviderAuthMethod[] = ["api_key", "codex_oauth"];
  return {
    ...EMPTY_MODEL_CATALOG,
    providers: [
      {
        provider_id: "openai",
        provider_label: "OpenAI",
        latest_model_ref: defaultModel.model_ref,
        auth_methods: authMethods,
        models: [defaultModel],
      },
    ],
    provider_credentials: [
      {
        id: "cred-existing",
        provider_id: "openai",
        label: "Existing key",
        masked_value: "sk-...",
        auth_type: "api_key",
        created_at: "2026-06-13T00:00:00.000Z",
        updated_at: "2026-06-13T00:00:00.000Z",
      },
    ],
    registered_models: [defaultModel],
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

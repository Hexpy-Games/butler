/// <reference types="bun" />

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { FIRST_RUN_CONSENT_VERSION } from "@/app/onboarding.ts";
import type { ModelCatalogView, SettingsView, SpaceView } from "@/app/types.ts";
import { useOnboardingStore } from "@/stores/onboardingStore.ts";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

// First-run language choices switch the app locale; hand it and the settings UI
// store back unchanged so later files in the same bun process start clean.
const initialAppLocale = getAppLocale();
const initialSettingsUIState = useSettingsUIStore.getState();
afterAll(() => {
  setAppCopyLanguage(initialAppLocale);
  useSettingsUIStore.setState(initialSettingsUIState, true);
});

interface TestStoreState {
  navigation: { space: SpaceView };
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
  navigation: { space: { revision: 0, nodes: [], groups: [] } },
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
const portalThemeCalls: Array<boolean | undefined> = [];
let systemPrefersDarkForTest = false;
let cachedStoreSnapshot: TestStoreState | null = null;

// mock.module is process-wide in bun; put the real modules back for later test files.
const mockedModuleSpecifiers = [
  "@/components/layout/Chrome.tsx",
  "@/components/layout/RightPanelOverlayTitlebar.tsx",
  "@/components/layout/Sidebar.tsx",
  "@/components/layout/Titlebar.tsx",
  "@/components/conversation/Conversation.tsx",
  "@/components/inspector/Inspector.tsx",
  "@/components/management/ProjectDashboardView.tsx",
  "@/components/management/AutomationsView.tsx",
  "@/components/settings/SettingsView.tsx",
  "@/components/command/CommandPalette.tsx",
  "@/components/layout/ProjectRenameDialog.tsx",
  "@/components/layout/SessionRenameDialog.tsx",
  "@/components/common/AppToaster.tsx",
  "@/hooks/useAppBootstrap.ts",
  "@/hooks/useNativeAppearanceTheme.ts",
  "@/hooks/useNativeShellPreferences.ts",
  "@/hooks/usePortalThemeClasses.ts",
  "@/hooks/useSystemThemePreference.ts",
  "@/hooks/useNarrowRightPanelAutoCollapse.ts",
  "@/hooks/usePanelResize.ts",
  "@/app/store.ts",
];
const originalModules = await Promise.all(
  mockedModuleSpecifiers.map(async (specifier) => [specifier, { ...(await import(specifier)) }] as const),
);
afterAll(() => {
  for (const [specifier, original] of originalModules) mock.module(specifier, () => original);
});

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
  usePortalThemeClasses: (_settings: SettingsView, prefersDark?: boolean) => {
    portalThemeCalls.push(prefersDark);
  },
}));
mock.module("@/hooks/useSystemThemePreference.ts", () => ({
  useSystemThemePreference: () => systemPrefersDarkForTest,
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
    openNewChat() {},
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
  portalThemeCalls.length = 0;
  systemPrefersDarkForTest = false;
  useOnboardingStore.setState({ rerunOpen: false, connectedCardId: null });
});

const LEGACY_KEY = "butler:first-run-setup:v1";
const legacyComplete = JSON.stringify({ schema: "butler.app.first-run.v1", status: "complete", completed_at: "2026-06-01T00:00:00.000Z" });
// #279: a fresh install answers every onboarding field as null.
const FRESH_ONBOARDING = { consent_version: null, accepted_at: null, completed_at: null };
const currentOnboarding = { consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: "2026-09-01", completed_at: "2026-09-01" };

test("a fresh install shows the welcome instead of the workspace", async () => {
  const rendered = await renderAppShell({}, { onboarding: FRESH_ONBOARDING });
  // The language comes from the system (jsdom: en-US); there is no language screen.
  await waitForText(rendered.container, "Welcome to Butler");
  expect(rendered.container.textContent).not.toContain("Workspace");
  expect(rendered.container.querySelector('[data-test-class="app-window-controls"]')).not.toBeNull();
  expect(rendered.container.querySelector('[data-test-class="app-window-close"]')).not.toBeNull();
  await act(async () => rendered.root.unmount());
});

test("an agent with completed onboarding and current consent opens the workspace directly", async () => {
  const rendered = await renderAppShell({}, { onboarding: currentOnboarding });
  await waitForText(rendered.container, "Workspace");
  expect(rendered.patches).toEqual([]);
  await act(async () => rendered.root.unmount());
});

test("an upgrade PATCHes the legacy completion once, then asks only for consent", async () => {
  const rendered = await renderAppShell({ [LEGACY_KEY]: legacyComplete }, { onboarding: FRESH_ONBOARDING });
  await waitForText(rendered.container, "시작하기 전에 확인해 주세요");
  expect(rendered.patches).toEqual([{ onboarding: { ...FRESH_ONBOARDING, completed_at: "2026-06-01T00:00:00.000Z" } }]);
  expect(rendered.storage.getItem(LEGACY_KEY)).toBeNull();
  await clickButton(rendered.container, "동의하고 시작");
  await waitForText(rendered.container, "어떤 AI와 일할까요?");
  expect(rendered.patches.at(-1)).toMatchObject({ onboarding: { consent_version: FIRST_RUN_CONSENT_VERSION } });
  await act(async () => rendered.root.unmount());
});

test("a newer consent version re-shows only the consent step", async () => {
  const rendered = await renderAppShell({}, { onboarding: { ...currentOnboarding, consent_version: FIRST_RUN_CONSENT_VERSION - 1 } });
  await waitForText(rendered.container, "시작하기 전에 확인해 주세요");
  await clickButton(rendered.container, "동의하고 시작");
  await waitForText(rendered.container, "어떤 AI와 일할까요?");
  expect(rendered.patches).toHaveLength(1);
  await act(async () => rendered.root.unmount());
});

test("an agent without onboarding support leaves the legacy flag in charge", async () => {
  const rendered = await renderAppShell({ [LEGACY_KEY]: legacyComplete }, {});
  await waitForText(rendered.container, "Workspace");
  expect(rendered.patches).toEqual([]);
  expect(rendered.storage.getItem(LEGACY_KEY)).toBe(legacyComplete);
  await act(async () => rendered.root.unmount());
});

test("Run setup again opens the setup over the workspace and Cancel changes nothing", async () => {
  const rendered = await renderAppShell({}, { onboarding: currentOnboarding });
  await waitForText(rendered.container, "Workspace");
  await act(async () => useOnboardingStore.getState().openRerun());
  await waitForText(rendered.container, "반갑습니다");
  await clickButton(rendered.container, "취소");
  await waitForText(rendered.container, "Workspace");
  expect(rendered.patches).toEqual([]);
  await act(async () => rendered.root.unmount());
});

test("first-run keeps the workspace chrome unmounted and gives the setup the resolved dark backdrop", async () => {
  systemPrefersDarkForTest = true;
  const rendered = await renderAppShell({}, { onboarding: FRESH_ONBOARDING });
  expect(rendered.container.textContent).not.toContain("Sidebar");
  expect(rendered.container.textContent).not.toContain("Titlebar");
  const setup = rendered.container.querySelector('[data-test-class="first-run-setup"]')!;
  expect(setup.getAttribute("data-tone")).toBe("dark");
  expect(portalThemeCalls).toContain(true);
  await act(async () => rendered.root.unmount());
});

async function renderAppShell(
  storageValues: Record<string, string>,
  agentSettings: Partial<SettingsView>,
): Promise<{ container: HTMLElement; root: Root; patches: unknown[]; storage: Storage }> {
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
  const patches: unknown[] = [];
  Object.assign(dom.window, {
    matchMedia: (media: string) => ({ media, matches: false, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }),
    butlerApp: {
      startSetup: async () => ({ diagnostics_available: true, phase: "ready" }),
      getSettings: async () => ({ ...EMPTY_SETTINGS, language: "ko", ...agentSettings }),
      getModelCatalog: async () => EMPTY_MODEL_CATALOG,
      getLocalModelServers: async () => ({ servers: [] }),
      updateSettings: async (patch: unknown) => {
        patches.push(patch);
        return {};
      },
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
  return { container, root, patches, storage: dom.window.localStorage };
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
  const deadline = Date.now() + 4000;
  while (!container.textContent?.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for text: ${text}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

import {
  DEFAULT_LEFT_PANEL_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampPanelWidth,
} from "./panelSizing.ts";

const APP_UI_STATE_SCHEMA = "butler.app-ui-state.v1";
const APP_UI_STATE_KEY = "butler:app-ui-state:v1";

export interface AppUiStateSnapshot {
  schema: typeof APP_UI_STATE_SCHEMA;
  cached_at: string;
  left_open: boolean;
  right_open: boolean;
  right_tab: string;
  left_panel_width: number;
  right_panel_width: number;
  sidebar_chats_collapsed: boolean;
  sidebar_projects_collapsed: boolean;
  sidebar_collapsed_project_ids: string[];
}

interface AppUiStateBridge {
  readCachedAppUiState?: () => Promise<unknown> | unknown;
  writeCachedAppUiState?: (input: {
    snapshot: AppUiStateSnapshot;
  }) => Promise<unknown> | unknown;
}

export type AppUiStateInput = Partial<
  Omit<AppUiStateSnapshot, "schema" | "cached_at">
>;

export async function readCachedAppUiState(): Promise<AppUiStateSnapshot | null> {
  const bridge = bridgeForUiState();
  if (bridge?.readCachedAppUiState) {
    return normalizeAppUiState(await bridge.readCachedAppUiState());
  }
  return normalizeAppUiState(readLocalAppUiState());
}

export async function writeCachedAppUiState(
  input: AppUiStateInput,
): Promise<void> {
  const snapshot = snapshotForAppUiState(input);
  const bridge = bridgeForUiState();
  if (bridge?.writeCachedAppUiState) {
    await bridge.writeCachedAppUiState({ snapshot });
    return;
  }
  writeLocalAppUiState(snapshot);
}

export function snapshotForAppUiState(
  input: AppUiStateInput,
): AppUiStateSnapshot {
  return {
    schema: APP_UI_STATE_SCHEMA,
    cached_at: new Date().toISOString(),
    left_open: input.left_open ?? false,
    right_open: input.right_open ?? true,
    right_tab: normalizeString(input.right_tab, "summary"),
    left_panel_width: clampPanelWidth(
      Number(input.left_panel_width ?? DEFAULT_LEFT_PANEL_WIDTH),
      LEFT_PANEL_MIN_WIDTH,
      LEFT_PANEL_MAX_WIDTH,
    ),
    right_panel_width: clampPanelWidth(
      Number(input.right_panel_width ?? DEFAULT_RIGHT_PANEL_WIDTH),
      RIGHT_PANEL_MIN_WIDTH,
      RIGHT_PANEL_MAX_WIDTH,
    ),
    sidebar_chats_collapsed: input.sidebar_chats_collapsed ?? false,
    sidebar_projects_collapsed: input.sidebar_projects_collapsed ?? false,
    sidebar_collapsed_project_ids: normalizeStringArray(
      input.sidebar_collapsed_project_ids,
    ),
  };
}

function normalizeAppUiState(value: unknown): AppUiStateSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AppUiStateSnapshot>;
  if (raw.schema !== APP_UI_STATE_SCHEMA) return null;
  return snapshotForAppUiState(raw);
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      ),
    ),
  );
}

function readLocalAppUiState(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(APP_UI_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalAppUiState(snapshot: AppUiStateSnapshot) {
  try {
    globalThis.localStorage?.setItem(APP_UI_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // UI state persistence is a convenience layer; app behavior stays intact.
  }
}

function bridgeForUiState(): AppUiStateBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as Window & { butlerApp?: AppUiStateBridge }).butlerApp;
}

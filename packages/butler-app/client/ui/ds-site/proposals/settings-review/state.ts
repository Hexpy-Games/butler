import type { WallpaperSource } from "@/butler-ds";

// Page state lives in the URL: every control below has a query key.

export type ProposalLocale = "ko-KR" | "en-US";
export type StageWidth = "desktop" | "768" | "375";
export type StageWallpaper = "clouds" | "daisies" | "bloom" | "none";
export type ReviewSection = "updates" | "motion" | "errors" | "approvals";

export type UpdateStage =
  | "available" | "checking" | "downloading" | "downloadingUnknown" | "verifying"
  | "ready" | "deferred" | "activating" | "failed" | "upToDate";
export type UpdateFailure = "download" | "damaged" | "incompatible" | "storage" | "apply" | "generic";
export type UpdateVariant = "proposal" | "codex";

export type MotionVariant = "accessibility" | "homeScreen" | "codex";
export type MotionState = "off" | "on" | "system";

export type ErrorScreen = "mcp" | "skills" | "hosts" | "wallpaper" | "toasts";
export type McpFieldError = "none" | "idRequired" | "idInvalid" | "commandRequired" | "urlRequired" | "saveFailed";

export type ApprovalsState = "list" | "long" | "empty" | "loading" | "error";
export type ApprovalsPlacement = "models" | "security";

export interface StageState {
  section: ReviewSection;
  theme: "light" | "dark";
  wallpaper: StageWallpaper;
  locale: ProposalLocale;
  update: UpdateStage;
  failure: UpdateFailure;
  updateVariant: UpdateVariant;
  motionVariant: MotionVariant;
  motion: MotionState;
  errorScreen: ErrorScreen;
  mcpError: McpFieldError;
  approvals: ApprovalsState;
  placement: ApprovalsPlacement;
}

export const DEFAULT_STATE: StageState = {
  section: "updates", theme: "light", wallpaper: "clouds", locale: "ko-KR",
  update: "downloading", failure: "download", updateVariant: "proposal",
  motionVariant: "accessibility", motion: "off",
  errorScreen: "mcp", mcpError: "idRequired",
  approvals: "list", placement: "models",
};

export const STAGE_MESSAGE = "butler-settings-review-proposal";

export const WALLPAPERS: Record<StageWallpaper, WallpaperSource> = {
  clouds: { kind: "live", module: "butler.photo-clouds" },
  daisies: { kind: "live", module: "butler.photo-daisies" },
  bloom: { kind: "live", module: "butler.bloom" },
  none: { kind: "none" },
};

export const STAGE_SIZE: Record<StageWidth, { width: number; height: number }> = {
  desktop: { width: 1280, height: 820 },
  "768": { width: 768, height: 960 },
  "375": { width: 375, height: 760 },
};

const CHOICES = {
  section: ["updates", "motion", "errors", "approvals"],
  theme: ["light", "dark"],
  wallpaper: ["clouds", "daisies", "bloom", "none"],
  locale: ["ko-KR", "en-US"],
  update: ["available", "checking", "downloading", "downloadingUnknown", "verifying", "ready", "deferred", "activating", "failed", "upToDate"],
  failure: ["download", "damaged", "incompatible", "storage", "apply", "generic"],
  updateVariant: ["proposal", "codex"],
  motionVariant: ["accessibility", "homeScreen", "codex"],
  motion: ["off", "on", "system"],
  errorScreen: ["mcp", "skills", "hosts", "wallpaper", "toasts"],
  mcpError: ["none", "idRequired", "idInvalid", "commandRequired", "urlRequired", "saveFailed"],
  approvals: ["list", "long", "empty", "loading", "error"],
  placement: ["models", "security"],
} as const satisfies { [K in keyof StageState]: readonly string[] };

export function stateFromQuery(params: URLSearchParams): StageState {
  const state = { ...DEFAULT_STATE } as Record<keyof StageState, string>;
  for (const key of Object.keys(CHOICES) as (keyof StageState)[]) {
    const value = params.get(key);
    if (value && (CHOICES[key] as readonly string[]).includes(value)) state[key] = value;
  }
  return state as unknown as StageState;
}

export function stateToQuery(state: StageState): URLSearchParams {
  return new URLSearchParams(Object.entries(state) as [string, string][]);
}

export function choices<K extends keyof StageState>(key: K): readonly StageState[K][] {
  return CHOICES[key] as unknown as readonly StageState[K][];
}

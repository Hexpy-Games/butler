import { appCopy } from "./copy.ts";
import type { SettingsView } from "./types.ts";

export type NativeNavigationRequest =
  | { action: "new-chat" }
  | { action: "open-session"; sessionId: string };

export type NativeNotificationDetailsCode =
  | "unsupported"
  | "macos-permission"
  | "windows-shortcut"
  | "linux-libnotify"
  | "platform-dependent"
  | "browser-unsupported"
  | "unavailable";

export type NativeNotificationSettingsTarget =
  | "macos-notifications"
  | "windows-notifications";

export interface NativeNotificationStatus {
  platform: string;
  supported: boolean;
  permission: "unknown" | "unsupported";
  source: "electron" | "browser";
  details_code: NativeNotificationDetailsCode;
  details: string;
  can_open_settings: boolean;
  settings_target?: NativeNotificationSettingsTarget | null;
  settings_label?: string | null;
  last_error?: string | null;
  last_attempted_at?: string | null;
  last_shown_at?: string | null;
}

export interface NativeNotificationResult {
  shown: boolean;
  reason?: "unsupported" | "focused" | "failed";
  error?: string;
  kind?: "assistant_message" | "task_completion" | "test";
  status: NativeNotificationStatus;
}

export interface NativeNotificationSettingsResult {
  opened: boolean;
  reason?: "unsupported" | "failed";
  error?: string;
  status: NativeNotificationStatus;
}

interface NativeShellBridge {
  platform?: string;
  getNativeNotificationStatus?: () => Promise<unknown>;
  testDesktopNotification?: () => Promise<unknown>;
  openNativeNotificationSettings?: () => Promise<unknown>;
  setNativeShellPreferences?: (input: {
    trayEnabled: boolean;
  }) => Promise<unknown>;
  showDesktopNotification?: (input: {
    kind: "assistant_message" | "task_completion" | "test";
    title: string;
    body: string;
    sessionId?: string;
    force?: boolean;
  }) => Promise<unknown>;
  onNativeNavigation?: (
    handler: (request: NativeNavigationRequest) => void,
  ) => (() => void) | Promise<() => void>;
}

function nativeBridge(): NativeShellBridge | null {
  if (typeof window === "undefined") return null;
  return (window.butlerApp ?? null) as NativeShellBridge | null;
}

export function platformClassName(): string {
  const platform = nativeBridge()?.platform || "browser";
  return `platform-${platform.replace(/[^a-z0-9_-]/giu, "-").toLocaleLowerCase("en-US")}`;
}

export async function setNativeShellPreferences(
  settings: Pick<SettingsView, "desktop_tray_enabled">,
): Promise<void> {
  const bridge = nativeBridge();
  if (typeof bridge?.setNativeShellPreferences !== "function") return;
  await bridge.setNativeShellPreferences({
    trayEnabled: settings.desktop_tray_enabled,
  });
}

export async function getNativeNotificationStatus(): Promise<
  NativeNotificationStatus
> {
  const bridge = nativeBridge();
  if (typeof bridge?.getNativeNotificationStatus !== "function") {
    return browserNotificationStatus();
  }
  return normalizeNativeNotificationStatus(
    await bridge.getNativeNotificationStatus(),
  );
}

export async function testDesktopNotification(): Promise<
  NativeNotificationResult
> {
  const bridge = nativeBridge();
  if (typeof bridge?.testDesktopNotification !== "function") {
    return {
      shown: false,
      reason: "unsupported",
      status: browserNotificationStatus(),
    };
  }
  return normalizeNativeNotificationResult(
    await bridge.testDesktopNotification(),
  );
}

export async function openNativeNotificationSettings(): Promise<
  NativeNotificationSettingsResult
> {
  const bridge = nativeBridge();
  if (typeof bridge?.openNativeNotificationSettings !== "function") {
    return {
      opened: false,
      reason: "unsupported",
      status: browserNotificationStatus(),
    };
  }
  return normalizeNativeNotificationSettingsResult(
    await bridge.openNativeNotificationSettings(),
  );
}

export async function showDesktopNotification(input: {
  kind: "assistant_message" | "task_completion";
  title: string;
  body: string;
  sessionId?: string;
}): Promise<NativeNotificationResult | null> {
  const bridge = nativeBridge();
  if (typeof bridge?.showDesktopNotification !== "function") return null;
  return normalizeNativeNotificationResult(
    await bridge.showDesktopNotification({
      ...input,
      body: compactNotificationBody(input.body),
    }),
  );
}

export function subscribeNativeNavigation(
  handler: (request: NativeNavigationRequest) => void,
): () => void {
  const bridge = nativeBridge();
  if (typeof bridge?.onNativeNavigation !== "function") return () => {};
  const unsubscribe = bridge.onNativeNavigation(handler);
  if (typeof unsubscribe === "function") return unsubscribe;
  void unsubscribe.catch(() => undefined);
  return () => {};
}

function compactNotificationBody(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return "Butler update is ready.";
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function browserNotificationStatus(): NativeNotificationStatus {
  return {
    platform: "browser",
    supported: false,
    permission: "unsupported",
    source: "browser",
    details_code: "browser-unsupported",
    details: nativeNotificationStatusDetails("browser-unsupported"),
    can_open_settings: false,
    settings_target: null,
    settings_label: null,
    last_error: null,
    last_attempted_at: null,
    last_shown_at: null,
  };
}

function normalizeNativeNotificationStatus(
  value: unknown,
): NativeNotificationStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return browserNotificationStatus();
  }
  const record = value as Record<string, unknown>;
  const supported =
    typeof record.supported === "boolean" ? record.supported : false;
  const permission =
    record.permission === "unknown" || record.permission === "unsupported"
      ? record.permission
      : supported
        ? "unknown"
        : "unsupported";
  const platform =
    typeof record.platform === "string" ? record.platform : "unknown";
  const detailsCode = normalizeNativeNotificationDetailsCode(
    record.details_code,
    supported,
    platform,
  );
  const settingsTarget = normalizeNativeNotificationSettingsTarget(
    record.settings_target,
  );
  return {
    platform,
    supported,
    permission,
    source: record.source === "electron" ? "electron" : "browser",
    details_code: detailsCode,
    details: nativeNotificationStatusDetails(detailsCode),
    can_open_settings: record.can_open_settings === true,
    settings_target: settingsTarget,
    settings_label: nativeNotificationSettingsLabel(settingsTarget),
    last_error:
      typeof record.last_error === "string" ? record.last_error : null,
    last_attempted_at:
      typeof record.last_attempted_at === "string"
        ? record.last_attempted_at
        : null,
    last_shown_at:
      typeof record.last_shown_at === "string" ? record.last_shown_at : null,
  };
}

function normalizeNativeNotificationDetailsCode(
  value: unknown,
  supported: boolean,
  platform: string,
): NativeNotificationDetailsCode {
  if (
    value === "unsupported" ||
    value === "macos-permission" ||
    value === "windows-shortcut" ||
    value === "linux-libnotify" ||
    value === "platform-dependent" ||
    value === "browser-unsupported" ||
    value === "unavailable"
  ) {
    return value;
  }
  if (!supported) return "unsupported";
  if (platform === "darwin") return "macos-permission";
  if (platform === "win32") return "windows-shortcut";
  if (platform === "linux") return "linux-libnotify";
  return "platform-dependent";
}

function normalizeNativeNotificationSettingsTarget(
  value: unknown,
): NativeNotificationSettingsTarget | null {
  if (value === "macos-notifications" || value === "windows-notifications") {
    return value;
  }
  return null;
}

function nativeNotificationStatusDetails(
  code: NativeNotificationDetailsCode,
): string {
  const copy = appCopy.settings.nativeNotifications.status;
  if (code === "unsupported") return copy.unsupported;
  if (code === "macos-permission") return copy.macosPermission;
  if (code === "windows-shortcut") return copy.windowsShortcut;
  if (code === "linux-libnotify") return copy.linuxLibnotify;
  if (code === "platform-dependent") return copy.platformDependent;
  if (code === "browser-unsupported") return copy.browserUnsupported;
  return copy.unavailable;
}

function nativeNotificationSettingsLabel(
  target: NativeNotificationSettingsTarget | null,
): string | null {
  const copy = appCopy.settings.nativeNotifications.settings;
  if (target === "macos-notifications") return copy.macos;
  if (target === "windows-notifications") return copy.windows;
  return null;
}

function normalizeNativeNotificationResult(
  value: unknown,
): NativeNotificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      shown: false,
      reason: "unsupported",
      status: browserNotificationStatus(),
    };
  }
  const record = value as Record<string, unknown>;
  const reason =
    record.reason === "unsupported" ||
    record.reason === "focused" ||
    record.reason === "failed"
      ? record.reason
      : undefined;
  const kind =
    record.kind === "assistant_message" ||
    record.kind === "task_completion" ||
    record.kind === "test"
      ? record.kind
      : undefined;
  return {
    shown: record.shown === true,
    reason,
    error: typeof record.error === "string" ? record.error : undefined,
    kind,
    status: normalizeNativeNotificationStatus(record.status),
  };
}

function normalizeNativeNotificationSettingsResult(
  value: unknown,
): NativeNotificationSettingsResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      opened: false,
      reason: "unsupported",
      status: browserNotificationStatus(),
    };
  }
  const record = value as Record<string, unknown>;
  const reason =
    record.reason === "unsupported" || record.reason === "failed"
      ? record.reason
      : undefined;
  return {
    opened: record.opened === true,
    reason,
    error: typeof record.error === "string" ? record.error : undefined,
    status: normalizeNativeNotificationStatus(record.status),
  };
}

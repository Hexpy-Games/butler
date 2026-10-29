import { pendingAsksBridgeInput } from "./pendingAsksBridge.ts";
import type { PendingAsksBridge } from "../../../shared/pending-asks-contracts.ts";
import { canonBridgeInput } from "./canonBridge.ts";
import { taskGraphBridgeInput } from "./taskGraphBridge.ts";
import { appCopy } from "./copy.ts";
import { artifactBridgeInput } from "./artifactBridge.ts";
import { requestTraceparent, withActionTrace } from "./traceparent.ts";
import type {
  AppInfoView,
  MessageFileRef,
  SettingsView,
  SkillImportResult,
  TimelineEvent,
  SessionView,
  SessionViewBridgeError,
  SessionViewBridgeInput,
  SessionViewBridgeResult,
  WorkStatusView,
} from "./types.ts";

declare global {
  interface Window {
    butlerApp?: ButlerAppBridge;
  }
}

export type SessionFolderLaunchTarget = "vscode" | "terminal" | "fileManager";

export type SessionFolderBridgeCode =
  | "bridge_unavailable"
  | "session_workspace_unavailable"
  | "launch_target_unavailable"
  | "session_folder_launch_failed";

export type SessionFolderLaunchTargetsResult =
  | { ok: true; targets: SessionFolderLaunchTarget[] }
  | {
      ok: false;
      code: SessionFolderBridgeCode;
      recoverable: true;
      targets: [];
    };

export type SessionFolderLaunchResult =
  | { ok: true; target: SessionFolderLaunchTarget }
  | {
      ok: false;
      code: SessionFolderBridgeCode;
      recoverable: true;
    };

export interface AppUpdateState {
  status: "idle" | "choice_required" | "deferred" | "preparing" | "restarting" | "failed";
  request_id: string | null;
}

export interface PowerState {
  onBattery: boolean;
  constrained: boolean;
}

interface ButlerAppBridge extends PendingAsksBridge {
  onTextSizeShortcut?: (handler: (command: "increase" | "decrease" | "reset") => void) => () => void;
  initialTextSize?: SettingsView["text_size"];
  setTextSize?: (value: SettingsView["text_size"]) => Promise<void>;
  log?: (row: { level: "DEBUG"; category: "http.client"; event: "image.fetch"; attrs: { url: string } }) => void;
  writeCachedComposerDraft?: (input: { snapshot: import("./composerDraftCache").ComposerDraftSnapshot }) => Promise<unknown>;
  history?: (input: { path: string; method: string; body?: unknown }) => Promise<unknown>;
  organizeLibrary?: (input: { path: string; method: string; body?: unknown }) => Promise<unknown>;
  listLibrary?: (input: Record<string, string>) => Promise<unknown>;
  saveLibrary?: (item: unknown) => Promise<unknown>;
  librarySnapshot?: (id: string) => Promise<unknown>;
  deleteLibrary?: (id: string) => Promise<unknown>;
  setUpdateProgress?: (value: number | "indeterminate" | null) => Promise<void>;
  recordUiCrash?: (input: unknown) => Promise<unknown>;
  /** One wallpaper run-state line (`wallpaper_state …`) for the main-process diagnostics log; fire and forget. */
  recordWallpaperState?: (line: string) => void;
  readUiCrashLog?: () => Promise<import("../../../electron/ui-crash-log.mjs").UiCrashEntry[]>;
  getAppUpdateState?: () => Promise<AppUpdateState>;
  chooseAppUpdate?: (input: { request_id: string | null; action: "now" | "defer" }) => Promise<{ ok: boolean }>;
  onAppUpdateState?: (handler: (state: AppUpdateState) => void) => () => void;
  onPowerState?: (handler: (state: PowerState) => void) => () => void;
  startupIssue?: "legacy-data" | null;
  recoverLegacyData?: (action: "open-folder" | "restart") => Promise<{ ok: boolean }>;
  protocolVersion?: string;
  serverUrl?: string;
  platform?: string;
  getSessionFolderLaunchTargets?: (input: {
    sessionId: string;
  }) => Promise<SessionFolderLaunchTargetsResult>;
  openSessionFolder?: (input: {
    sessionId: string;
    target: SessionFolderLaunchTarget;
  }) => Promise<SessionFolderLaunchResult>;
  exportDocument?: (input: { format: "markdown" | "pdf"; name: string; content: string }) => Promise<unknown>;
  saveMessageFile?: (input?: unknown) => Promise<unknown>;
  openMessageFile?: (input?: unknown) => Promise<unknown>;
  showDesktopNotification?: (input?: unknown) => Promise<unknown>;
  getNativeNotificationStatus?: () => Promise<unknown>;
  testDesktopNotification?: () => Promise<unknown>;
  getSessionView?: (
    input?: SessionViewBridgeInput,
  ) => Promise<SessionViewBridgeResult | SessionView>;
  getWorkStatus?: () => Promise<WorkStatusView>;
  getAuthorityPermissions?: () => Promise<unknown>;
  revokeAuthorityPermissions?: (input: unknown) => Promise<unknown>;
  getAuthorityRequests?: (input?: unknown) => Promise<unknown>;
  allowAuthorityRequest?: (input?: unknown) => Promise<unknown>;
  revokeConversationPermission?: (input?: unknown) => Promise<unknown>;
  denyAuthorityRequest?: (input?: unknown) => Promise<unknown>;
  answerUserQuestions?: (input?: unknown) => Promise<unknown>;
  modifyAuthorityRequest?: (input?: unknown) => Promise<unknown>;
  openNativeNotificationSettings?: () => Promise<unknown>;
  setNativeShellPreferences?: (input?: unknown) => Promise<unknown>;
  subscribeLiveEvents?: (
    input?: { cursor?: number },
    handlers?: {
      onEvent?: (event: TimelineEvent) => void;
      onError?: (error: unknown) => void;
      onOpen?: () => void;
      onHeartbeat?: () => void;
    },
  ) => (() => void) | void;
  onNativeNavigation?: (
    handler: (request: unknown) => void,
  ) => (() => void) | Promise<() => void>;
  [method: string]: unknown;
}

type ApiOptions = RequestInit & { body?: BodyInit | Record<string, unknown> | null };

export async function api<T = unknown>(path: string, init: ApiOptions = {}): Promise<T> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  const options = withActionTrace(path, init);
  const request = (requestPath: string) => bridge
    ? bridgeRequest<T>(bridge, requestPath, options)
    : browserRequest<T>(requestPath, options);
  try {
    return await request(path);
  } catch (error) {
    const resyncPath = sessionViewResyncPath(path, options, error);
    if (!resyncPath) throw error;
    return await request(resyncPath);
  }
}

export async function getWorkStatus(): Promise<WorkStatusView> {
  return await api<WorkStatusView>("/work-status");
}

function sessionViewResyncPath(
  path: string,
  options: ApiOptions,
  error: unknown,
): string | null {
  if (String(options.method ?? "GET").toUpperCase() !== "GET") return null;
  if (!error || typeof error !== "object" ||
    (error as { code?: unknown }).code !== "session_cursor_resync_required") return null;
  const url = new URL(path, "http://butler.local");
  if (url.pathname !== "/session-view") return null;
  const hasOpaqueCursor = url.searchParams.has("cursor_token") ||
    url.searchParams.has("before_cursor_token");
  if (!hasOpaqueCursor) return null;
  url.searchParams.delete("cursor_token");
  url.searchParams.delete("before_cursor_token");
  return `${url.pathname}${url.search}`;
}

export async function uploadMessageFile(file: File, sessionId?: string): Promise<MessageFileRef> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.uploadMessageFile === "function") {
    const bytes = await file.arrayBuffer();
    const result = await callBridge<{ file: MessageFileRef }>(bridge, "uploadMessageFile", {
      name: file.name,
      mimeType: file.type,
      sessionId,
      bytes,
    });
    return result.file;
  }

  const form = new FormData();
  form.set("file", file, file.name);
  if (sessionId) form.set("session_id", sessionId);
  const response = await fetch("/message-files", {
    method: "POST",
    body: form,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? appCopy.interfaceFeedback.uploadFailed);
  return payload.data.file as MessageFileRef;
}

/** An image-edit mask is binary: like a message file it crosses the desktop bridge as bytes, not as a JSON route. */
export async function uploadImageMask(session: string, image: string, mask: Blob): Promise<string> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (bridge) return unwrapBridgeResult(await callBridge<BridgeResult<{ id: string }>>(bridge, "uploadImageMask",
    { session, image, bytes: new Uint8Array(await mask.arrayBuffer()) })).id;
  const path = `/message-assets/masks?${new URLSearchParams({ session, for: image })}`;
  return (await browserRequest<{ id: string }>(path, withActionTrace(path,
    { method: "POST", body: mask, headers: { "content-type": "image/png" } }))).id;
}

export async function importSkillZip(file: File, projectId?: string): Promise<SkillImportResult> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.importSkill === "function") {
    return await callBridge<SkillImportResult>(bridge, "importSkill", {
      name: file.name,
      projectId,
      bytes: await file.arrayBuffer(),
    });
  }
  const form = new FormData();
  form.set("file", file, file.name);
  if (projectId) form.set("project_id", projectId);
  const response = await fetch("/skills/import", {
    method: "POST",
    body: form,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(appCopy.interfaceFeedback.importFailed), {
      code: typeof payload?.error?.code === "string" ? payload.error.code : "request_failed",
      status: response.status,
    });
  }
  return payload.data as SkillImportResult;
}

export function liveEventsUrl(cursor = 0): string {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  const baseUrl = typeof bridge?.serverUrl === "string" && bridge.serverUrl
    ? bridge.serverUrl
    : window.location.origin;
  const url = new URL("/events/live", baseUrl);
  url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

export function subscribeLiveEvents(
  cursor: number,
  onEvent: (event: TimelineEvent) => void,
  onError: (error: unknown) => void,
  onOpen?: () => void,
  onHeartbeat?: () => void,
): () => void {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.subscribeLiveEvents === "function") {
    const unsubscribe = bridge.subscribeLiveEvents(
      { cursor },
      { onEvent, onError, onOpen, onHeartbeat },
    );
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }
  if (typeof EventSource === "undefined") {
    onError(new Error("Live event stream is unavailable in this browser."));
    return () => {};
  }
  const liveSource = new EventSource(liveEventsUrl(cursor));
  liveSource.onopen = () => onOpen?.();
  liveSource.addEventListener("heartbeat", () => onHeartbeat?.());
  liveSource.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as TimelineEvent);
    } catch (error) {
      liveSource.close();
      onError(error);
    }
  };
  liveSource.onerror = () => {
    liveSource.close();
    onError(new Error("Live event stream failed."));
  };
  return () => liveSource.close();
}

export async function setNativeAppearanceTheme(
  theme: SettingsView["appearance_theme"],
): Promise<void> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.setNativeAppearanceTheme !== "function") return;
  await callBridge(bridge, "setNativeAppearanceTheme", { theme });
}

export async function setDeveloperMode(enabled: boolean): Promise<AppInfoView> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.setDeveloperMode === "function") {
    return await callBridge<AppInfoView>(bridge, "setDeveloperMode", {
      enabled,
    });
  }
  return await api<AppInfoView>("/app-info");
}

function browserRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(appCopy.serverErrors[body.error?.code] ?? body.error?.message ?? appCopy.interfaceFeedback.requestFailed);
      Object.assign(error, {
        ...(typeof body.error?.code === "string" ? { code: body.error.code } : {}),
        status: response.status,
        ...(body.error?.code === "tag_exists" && body.error?.existing ? { existing: body.error.existing } : {}),
        ...(Number.isSafeInteger(body.error?.current?.revision) ? { current: { revision: body.error.current.revision } } : {}),
      });
      throw error;
    }
    return body.data as T;
  });
}

async function bridgeRequest<T>(bridge: ButlerAppBridge, path: string, options: ApiOptions = {}): Promise<T> {
  const method = String(options.method ?? "GET").toUpperCase();
  const url = new URL(path, window.location.origin);
  // User actions carry their trace context to the agent (set by api()).
  const traceparent = requestTraceparent(options.headers);
  if (url.pathname === "/browser-history" || url.pathname.startsWith("/browser-history/")) return callBridge<T>(bridge, "history", { path: url.pathname + url.search, method, ...(options.body == null ? {} : { body: parseBody(options.body) }) });
  if (url.pathname === "/library" && method === "GET") return callBridge<T>(bridge,"listLibrary",Object.fromEntries(url.searchParams));
  if (method === "POST" && ["/library/documents", "/library/blocks"].includes(url.pathname)) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, url.pathname === "/library/documents" ? "saveLibraryDocument" : "saveLibraryBlock", parseBody(options.body)));
  }
  if (/^\/documents(?:\/|$)/u.test(url.pathname)) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "documents", { path: url.pathname + url.search, method,
      ...(options.body == null ? {} : { body: parseBody(options.body) }) }));
  }
  const previewView = method === "GET" ? url.pathname.match(/^\/previews\/([^/]+)\/view$/u) : null;
  if (previewView) {
    let previewId: string;
    try { previewId = decodeURIComponent(previewView[1]!); }
    catch { throw new Error("Invalid preview"); }
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "getPreviewView", { previewId, query: url.search }));
  }
  if (url.pathname === "/library" && method === "POST") return callBridge<T>(bridge,"saveLibrary",parseBody(options.body));
  if (url.pathname.startsWith("/library/") && url.pathname.endsWith("/snapshot") && method === "GET") return callBridge<T>(bridge,"librarySnapshot",decodeURIComponent(url.pathname.slice(9, -9)));
  if (/^\/library\/(groups|tags|facets|items)(\/|$)/.test(url.pathname)) return callBridge<T>(bridge, "organizeLibrary", { path: url.pathname + url.search, method, ...(options.body == null ? {} : { body: parseBody(options.body) }) });
  if (url.pathname.startsWith("/library/") && method === "DELETE") return callBridge<T>(bridge,"deleteLibrary",decodeURIComponent(url.pathname.slice(9)));
  if (url.pathname === "/settings/image-model" && (method === "GET" || method === "PUT"))
    return unwrapBridgeResult<T>(await callBridge(bridge, "imageModelSettings", { method, body: method === "PUT" ? parseBody(options.body) : undefined }));
  if (method === "GET" && /^\/message-assets\/img_[a-z0-9]+\/(meta|versions)$/u.test(url.pathname))
    return unwrapBridgeResult<T>(await callBridge(bridge, "imageAssetInfo", { path: url.pathname }));
  const asks = pendingAsksBridgeInput(url, method);
  if (asks) return await callBridge<T>(bridge, asks.method, asks.input);
  const canon = canonBridgeInput(url, method, () => parseBody(options.body));
  if (canon) return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, canon.method, canon.input));
  const graph = method === "GET" ? taskGraphBridgeInput(url) : null;
  if (graph) return await callBridge<T>(bridge, graph.method, graph.input);
  if (method === "GET" && url.pathname === "/health") return await callBridge<T>(bridge, "health");
  if (method === "GET" && url.pathname === "/setup/status") return await callBridge<T>(bridge, "getSetupStatus");
  if (method === "POST" && url.pathname === "/setup/start") return await callBridge<T>(bridge, "startSetup", parseBody(options.body));
  if (method === "POST" && url.pathname === "/setup/cancel") return await callBridge<T>(bridge, "cancelSetup", parseBody(options.body));
  if (method === "GET" && url.pathname === "/setup/diagnostics") return await callBridge<T>(bridge, "exportSetupDiagnostics");
  // #230 first-run routes (Rust agent, #279). Envelopes keep the public error code across contextBridge.
  if (method === "GET" && url.pathname === "/setup/readiness") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "getSetupReadiness"));
  }
  if (method === "POST" && url.pathname === "/setup/readiness/retry") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "retrySetupReadiness", parseBody(options.body)));
  }
  if (method === "POST" && url.pathname === "/setup/memory-model") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "chooseMemoryModel", parseBody(options.body)));
  }
  if (method === "GET" && url.pathname === "/setup/chatgpt-account") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "getChatGptAccount"));
  }
  if (method === "POST" && url.pathname === "/setup/chatgpt-account/notice") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "acknowledgeChatGptNotice", parseBody(options.body)));
  }
  if (method === "POST" && url.pathname === "/setup/chatgpt-account/sign-out") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "signOutChatGpt"));
  }
  if (method === "POST" && url.pathname === "/setup/oauth/start") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "startSetupOAuth", parseBody(options.body)));
  }
  if (method === "GET" && url.pathname === "/setup/local-model-servers") return await callBridge<T>(bridge, "getLocalModelServers");
  if (method === "POST" && url.pathname === "/setup/credentials/verify") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "verifySetupCredential", parseBody(options.body)));
  }
  if (method === "POST" && url.pathname === "/credentials") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "saveCredential", parseBody(options.body)));
  }
  // #217 saved keys: list (masked), replace (`verify`), delete (`?force=true`).
  if (method === "GET" && url.pathname === "/credentials") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "listCredentials"));
  }
  const credentialMatch = url.pathname.match(/^\/credentials\/([^/]+)$/u);
  if (method === "PATCH" && credentialMatch) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "replaceCredential", {
      name: decodeURIComponent(credentialMatch[1]!),
      request: parseBody(options.body),
    }));
  }
  if (method === "DELETE" && credentialMatch) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "deleteCredential", {
      name: decodeURIComponent(credentialMatch[1]!),
      force: url.searchParams.get("force") === "true",
    }));
  }
  const setupOAuthCancel = method === "POST" ? url.pathname.match(/^\/setup\/oauth\/([^/]+)\/cancel$/u) : null;
  if (setupOAuthCancel) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "cancelSetupOAuth", {
      flowId: decodeURIComponent(setupOAuthCancel[1]!),
    }));
  }
  const setupOAuthFlow = method === "GET" ? url.pathname.match(/^\/setup\/oauth\/([^/]+)$/u) : null;
  if (setupOAuthFlow) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "getSetupOAuthFlow", {
      flowId: decodeURIComponent(setupOAuthFlow[1]!),
    }));
  }
  if (method === "GET" && url.pathname === "/chats") return await callBridge<T>(bridge, "listChats");
  if (method === "GET" && url.pathname === "/navigation") return await callBridge<T>(bridge, "listNavigation");
  if (url.pathname.startsWith("/space/")) {
    const group = url.pathname.match(/^\/space\/groups\/([^/]+)$/);
    if (group && (method === "PATCH" || method === "DELETE")) {
      return await callBridge<T>(bridge, "changeSpaceGroup", { groupId: decodeURIComponent(group[1]!), method, body: parseBody(options.body) });
    }
    const resources = ["groups", "moves", "group-sessions", "undo", "pins", "relocations", "branches", "branch-source"];
    const resource = url.pathname.slice("/space/".length);
    if (method === "POST" && resources.includes(resource)) {
      return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "mutateSpace", { resource, body: parseBody(options.body) }));
    }
  }
  if (method === "GET" && url.pathname === "/work-status") return await callBridge<T>(bridge, "getWorkStatus");
  if (method === "GET" && url.pathname === "/new-chat-briefing") {
    return await callBridge<T>(bridge, "getNewChatBriefing", {
      date: url.searchParams.get("date") ?? undefined,
      projectId: url.searchParams.get("project_id") ?? undefined,
    });
  }
  if (method === "GET" && url.pathname === "/settings") return await callBridge<T>(bridge, "getSettings");
  if (method === "GET" && url.pathname === "/app-info") return await callBridge<T>(bridge, "getAppInfo");
  if (method === "GET" && url.pathname === "/updates") return await callBridge<T>(bridge, "getUpdates");
  if (method === "POST" && url.pathname === "/updates/cancel") return await callBridge<T>(bridge, "cancelUpdate");
  if (method === "POST" && url.pathname === "/updates/check") {
    return await callBridge<T>(bridge, "checkUpdates", parseBody(options.body));
  }
  if (method === "POST" && url.pathname === "/updates/apply") {
    return await callBridge<T>(bridge, "applyUpdate", parseBody(options.body));
  }
  if (method === "GET" && url.pathname === "/hooks") return unwrapBridgeResult<T>(await callBridge(bridge, "getHooks"));
  if (method === "GET" && url.pathname === "/hooks/runs") return unwrapBridgeResult<T>(await callBridge(bridge, "getHookRuns"));
  if (method === "PUT" && url.pathname === "/hooks") return unwrapBridgeResult<T>(await callBridge(bridge, "saveHooks", parseBody(options.body)));
  const hookTest = method === "POST" ? url.pathname.match(/^\/hooks\/([a-z0-9_-]+)\/test$/iu) : null;
  if (hookTest) return unwrapBridgeResult<T>(await callBridge(bridge, "testHook", { hookId: hookTest[1] }));
  if (method === "GET" && url.pathname === "/mcp-servers") return await callBridge<T>(bridge, "listMcpServers");
  if (method === "GET" && url.pathname === "/mcp-capabilities") return await callBridge<T>(bridge, "listMcpCapabilities");
  if (method === "GET" && url.pathname === "/skills") return await callBridge<T>(bridge, "listSkills");
  if (method === "POST" && url.pathname === "/skills/import") {
    return await callBridge<T>(bridge, "importSkill", parseBody(options.body));
  }
  if (method === "POST" && url.pathname === "/mcp-servers") {
    return await callBridge<T>(bridge, "createMcpServer", parseBody(options.body));
  }
  const mcpProbeMatch = method === "POST" ? url.pathname.match(/^\/mcp-servers\/([^/]+)\/probe$/u) : null;
  if (mcpProbeMatch) {
    return await callBridge<T>(bridge, "probeMcpServer", {
      serverId: decodeURIComponent(mcpProbeMatch[1]!),
    });
  }
  const mcpServerMatch = url.pathname.match(/^\/mcp-servers\/([^/]+)$/u);
  if (method === "PATCH" && mcpServerMatch) {
    return await callBridge<T>(bridge, "updateMcpServer", {
      serverId: decodeURIComponent(mcpServerMatch[1]!),
      request: parseBody(options.body),
    });
  }
  if (method === "DELETE" && mcpServerMatch) {
    return await callBridge<T>(bridge, "deleteMcpServer", {
      serverId: decodeURIComponent(mcpServerMatch[1]!),
    });
  }
  if (method === "GET" && url.pathname === "/personalization") return await callBridge<T>(bridge, "getPersonalization");
  if (method === "GET" && url.pathname === "/personalization/profile-import-prompt") {
    return await callBridge<T>(bridge, "getProfileImportPrompt", {
      locale: url.searchParams.get("locale") ?? undefined,
    });
  }
  if (method === "PATCH" && url.pathname === "/personalization") {
    return await callBridge<T>(bridge, "updatePersonalization", parseBody(options.body));
  }
  if (method === "POST" && url.pathname === "/personalization/profile-import") {
    return await callBridge<T>(bridge, "importPersonalizationProfile", parseBody(options.body));
  }
  if (method === "GET" && url.pathname === "/model-catalog") return await callBridge<T>(bridge, "getModelCatalog");
  if (method === "POST" && url.pathname === "/model-catalog/provider-credentials") {
    return await callBridge<T>(bridge, "upsertProviderCredential", parseBody(options.body));
  }
  if (method === "POST" && url.pathname === "/model-catalog/registered-models") {
    return await callBridge<T>(bridge, "registerHostedModel", parseBody(options.body));
  }
  const hostedModelMatch = url.pathname.match(/^\/model-catalog\/registered-models\/([^/]+(?:\/[^/]+)?)$/u);
  if (method === "DELETE" && hostedModelMatch) {
    return await callBridge<T>(bridge, "deleteHostedModel", {
      modelRef: decodeURIComponent(hostedModelMatch[1]!),
    });
  }
  if (method === "POST" && url.pathname === "/model-catalog/local/discover") {
    return await callBridge<T>(bridge, "discoverLocalModels", parseBody(options.body));
  }
  if (method === "POST" && url.pathname === "/model-catalog/local-models") {
    return await callBridge<T>(bridge, "registerLocalModel", parseBody(options.body));
  }
  const localModelMatch = url.pathname.match(/^\/model-catalog\/local-models\/([^/]+)$/u);
  if (method === "PATCH" && localModelMatch) {
    return await callBridge<T>(bridge, "updateLocalModel", {
      modelRef: decodeURIComponent(localModelMatch[1]!),
      request: parseBody(options.body),
    });
  }
  if (method === "DELETE" && localModelMatch) {
    return await callBridge<T>(bridge, "deleteLocalModel", {
      modelRef: decodeURIComponent(localModelMatch[1]!),
    });
  }
  if (method === "PATCH" && url.pathname === "/settings") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "updateSettings", parseBody(options.body)));
  }
  if (method === "GET" && url.pathname === "/security") {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "getSecurity"));
  }
  if (url.pathname === "/security/pairing" && (method === "GET" || method === "POST")) {
    const action = method === "POST" ? "issuePairingCode" : "getPairingStatus";
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, action));
  }
  if (url.pathname === "/security/devices" && (method === "GET" || method === "DELETE")) {
    const action = method === "GET" ? "listPairedDevices" : "revokeAllPairedDevices";
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, action));
  }
  const signIns = signInBridgeCall(method, url.pathname, options.body);
  if (signIns) return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, signIns.action, signIns.input));
  const deviceMatch = url.pathname.match(/^\/security\/devices\/([^/]+)$/u);
  if (method === "DELETE" && deviceMatch) {
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "revokePairedDevice", {
      deviceId: decodeURIComponent(deviceMatch[1]!),
    }));
  }
  if (method === "GET" && url.pathname === "/command-palette") {
    return await callBridge<T>(bridge, "searchCommandPalette", { query: url.searchParams.get("query") ?? "" });
  }
  if (method === "GET" && url.pathname === "/archives") {
    return await callBridge<T>(bridge, "listArchives", paginationRequest(url.searchParams));
  }
  if (method === "GET" && url.pathname === "/system-events") {
    return await callBridge<T>(bridge, "listSystemEvents", paginationRequest(url.searchParams));
  }
  if (["/logs", "/logs/config", "/logs/storage", "/logs/trace"].includes(url.pathname) || url.pathname.startsWith("/logs/trace/")) {
    return await callBridge<T>(bridge, "logs", { path: url.pathname + url.search, method, ...(options.body == null ? {} : { body: parseBody(options.body) }) });
  }
  if (method === "GET" && url.pathname === "/usage-history") {
    return await callBridge<T>(bridge, "getUsageHistory", { query: url.search });
  }
  if (method === "GET" && url.pathname === "/usage-monitor") {
    return await callBridge<T>(bridge, "getUsageMonitor", {
      // Preserve the joint session/range filter for the native bridge as well as HTTP.
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
      sinceHours: numericSearchParam(url.searchParams, "since_hours") ??
        numericSearchParam(url.searchParams, "sinceHours"),
    });
  }
  if (method === "GET" && url.pathname === "/provider-quota") {
    return await callBridge<T>(bridge, "getProviderQuota", {
      providerId: url.searchParams.get("provider_id") ?? "",
    });
  }
  if (method === "GET" && url.pathname === "/session-summary") {
    return await callBridge<T>(bridge, "getSessionSummary", {
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
    });
  }
  if (method === "GET" && url.pathname === "/session-view") {
    if (["cursor", "after_cursor", "before_cursor", "beforeCursor"].some((key) =>
      url.searchParams.has(key))) {
      const error = new Error("Session view must be resynchronized.");
      Object.assign(error, {
        code: "session_cursor_resync_required",
        status: 409,
        resync: {
          required: true,
          resource: "session-view",
          reason: "cursor-expired",
        },
      });
      throw error;
    }
    const result = await callBridge<SessionViewBridgeResult | T>(bridge, "getSessionView", {
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
      cursorToken: url.searchParams.get("cursor_token") ?? undefined,
      beforeCursorToken: url.searchParams.get("before_cursor_token") ?? undefined,
      limit: numericSearchParam(url.searchParams, "limit"),
    });
    return unwrapSessionViewBridgeResult<T>(result);
  }
  if (method === "GET" && url.pathname === "/context-details") {
    return await callBridge<T>(bridge, "getContextDetails", {
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
    });
  }
  const artifact = artifactBridgeInput(method, url);
  if (artifact) return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, artifact.method, artifact.input));
  if (method === "GET" && url.pathname === "/transcript-export") {
    return await callBridge<T>(bridge, "exportTranscript", {
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
    });
  }
  if (method === "GET" && url.pathname === "/projects") {
    return await callBridge<T>(bridge, "listProjects", {
      includeSessions: url.searchParams.get("include_sessions") === "true",
    });
  }
  if (method === "POST" && url.pathname === "/projects") {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "createProject", {
      source: body.source,
      displayName: body.display_name,
      folderSelectionToken: body.folder_selection_token,
      idempotencyKey: body.idempotency_key,
    });
  }
  if (url.pathname.startsWith("/memory/")) {
    const result = await callBridge<BridgeResult<T> | T>(bridge, "memoryRequest", {
      path: url.pathname, method,
      ...(options.body == null ? {} : { body: parseBody(options.body) }),
    });
    return /^\/memory\/(?:pattern-proposals(?:\/[^/]+)?|consolidation)$/u.test(url.pathname) ? unwrapBridgeResult<T>(result) : result as T;
  }
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch && method === "PATCH") {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "updateProject", {
      projectId: decodeURIComponent(projectMatch[1]),
      displayName: body.display_name,
      pinned: body.pinned,
      archived: body.archived,
    });
  }
  if (projectMatch && method === "DELETE") {
    return await callBridge<T>(
      bridge,
      url.searchParams.get("permanent") === "true" ? "deleteProjectPermanent" : "deleteProject",
      { projectId: decodeURIComponent(projectMatch[1]) },
    );
  }
  const projectDashboardMatch = method === "GET" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard$/) : null;
  const dashboardResource = url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/(records|materials|source|history|artifacts|statistics|preferences|briefing|attachment)$/u);
  if (dashboardResource) {
    const projectId = decodeURIComponent(dashboardResource[1]!);
    const resource = dashboardResource[2]!;
    if (method === "GET" && !["preferences", "briefing", "attachment"].includes(resource)) {
      return await callBridge<T>(bridge, "getProjectDashboardResource", { projectId, resource, query: url.searchParams.toString() });
    }
    if ((method === "PATCH" && resource === "preferences") || (method === "POST" && ["briefing", "attachment"].includes(resource))) {
      return await callBridge<T>(bridge, "updateProjectDashboardResource", { projectId, resource, body: parseBody(options.body) });
    }
  }
  if (projectDashboardMatch) {
    return await callBridge<T>(bridge, "getProjectDashboard", { projectId: decodeURIComponent(projectDashboardMatch[1]!) });
  }
  const projectArchiveMatch = method === "POST" ? url.pathname.match(/^\/projects\/([^/]+)\/archive$/) : null;
  if (projectArchiveMatch) return await callBridge<T>(bridge, "archiveProject", { projectId: decodeURIComponent(projectArchiveMatch[1]) });
  const projectPinMatch = method === "POST" ? url.pathname.match(/^\/projects\/([^/]+)\/pin$/) : null;
  if (projectPinMatch) {
    return await callBridge<T>(bridge, "pinProject", {
      projectId: decodeURIComponent(projectPinMatch[1]),
      pinned: parseBody(options.body).pinned,
    });
  }
  if (method === "GET" && url.pathname === "/sessions") {
    return await callBridge<T>(bridge, "listSessions", {
      kind: url.searchParams.get("kind") ?? undefined,
      projectId: url.searchParams.get("project_id") ?? undefined,
    });
  }
  if (method === "POST" && url.pathname === "/sessions") {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "createSession", {
      kind: body.kind,
      title: body.title,
      initialMessage: body.initial_message,
      workspaceMode: body.workspace_mode,
      projectId: body.project_id,
      sessionHint: body.session_hint,
      idempotencyKey: body.idempotency_key,
    });
  }
  if (method === "POST" && url.pathname === "/sessions/general/clear") {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "clearGeneral", { title: body.title });
  }
  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/u);
  if (method === "PATCH" && sessionMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "updateSession", {
      sessionId: decodeURIComponent(sessionMatch[1]!),
      title: body.title,
      archived: body.archived,
    });
  }
  const sessionArchiveMatch = url.pathname.match(/^\/sessions\/([^/]+)\/archive$/u);
  if (method === "POST" && sessionArchiveMatch) {
    return await callBridge<T>(bridge, "archiveSession", {
      sessionId: decodeURIComponent(sessionArchiveMatch[1]!),
    });
  }
  const composingMatch = method === "POST" ? url.pathname.match(/^\/sessions\/([^/]+)\/composing$/u) : null;
  if (composingMatch) return await callBridge<T>(bridge, "sessionComposing", { sessionId: decodeURIComponent(composingMatch[1]!) });
  const reportPauseMatch = method === "POST" ? url.pathname.match(/^\/automations\/([^/]+)\/report-pause$/u) : null;
  if (reportPauseMatch) return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "decideReportPause", {
    automationId: decodeURIComponent(reportPauseMatch[1]!), decision: parseBody(options.body).decision,
  }));
  const sessionReadMatch = url.pathname.match(/^\/sessions\/([^/]+)\/read$/u);
  if (method === "POST" && sessionReadMatch) {
    return await callBridge<T>(bridge, "markSessionRead", {
      sessionId: decodeURIComponent(sessionReadMatch[1]!),
    });
  }
  if (method === "DELETE" && sessionMatch) {
    return await callBridge<T>(
      bridge,
      url.searchParams.get("permanent") === "true" ? "deleteSessionPermanent" : "archiveSession",
      { sessionId: decodeURIComponent(sessionMatch[1]!) },
    );
  }
  const sessionControlsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/controls$/);
  if (method === "GET" && sessionControlsMatch) {
    return await callBridge<T>(bridge, "getSessionControls", { sessionId: decodeURIComponent(sessionControlsMatch[1]!) });
  }
  if (method === "PATCH" && sessionControlsMatch) {
    return await callBridge<T>(bridge, "updateSessionControls", {
      sessionId: decodeURIComponent(sessionControlsMatch[1]!),
      controls: parseBody(options.body),
      traceparent,
    });
  }
  const planDecisionMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/plan-decisions\/([^/]+)$/u,
  );
  if (method === "POST" && planDecisionMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "decideSessionPlan", {
      sessionId: decodeURIComponent(planDecisionMatch[1]!),
      planId: decodeURIComponent(planDecisionMatch[2]!),
      action: body.action,
      instruction: body.instruction,
    });
  }
  if (method === "GET" && url.pathname === "/project-sessions") {
    return await callBridge<T>(bridge, "listProjectSessions", {
      projectId: url.searchParams.get("project_id") ?? undefined,
    });
  }
  if (method === "GET" && url.pathname === "/messages") {
    return await callBridge<T>(bridge, "listMessages", {
      chatId: url.searchParams.get("chat_id") ?? "general",
      cursor: Number(url.searchParams.get("cursor") ?? "0"),
    });
  }
  if (method === "GET" && url.pathname === "/session-queue") {
    return await callBridge<T>(bridge, "listSessionQueue", {
      sessionId: url.searchParams.get("session_id") ?? "general",
    });
  }
  if (method === "GET" && url.pathname === "/authority-permissions") {
    return await callBridge<T>(bridge, "getAuthorityPermissions", {});
  }
  if (method === "POST" && url.pathname === "/authority-permissions/revoke") {
    return await callBridge<T>(bridge, "revokeAuthorityPermissions", parseBody(options.body));
  }
  if (method === "GET" && url.pathname === "/authority-requests") {
    return await callBridge<T>(bridge, "getAuthorityRequests", {
      sessionId: url.searchParams.get("session_id") ?? undefined,
    });
  }
  const authorityAllowMatch = url.pathname.match(
    /^\/authority-requests\/([^/]+)\/allow$/u,
  );
  if (method === "POST" && authorityAllowMatch) {
    return await callBridge<T>(bridge, "allowAuthorityRequest", {
      sessionId: url.searchParams.get("session_id") ?? undefined,
      requestRef: decodeURIComponent(authorityAllowMatch[1] ?? ""),
      scope: parseBody(options.body).scope,
    });
  }
  const authorityRevokeMatch = url.pathname.match(/^\/authority-permissions\/([^/]+)$/u);
  if (method === "DELETE" && authorityRevokeMatch) {
    return await callBridge<T>(bridge, "revokeConversationPermission", {
      sessionId: url.searchParams.get("session_id") ?? undefined,
      grantRef: decodeURIComponent(authorityRevokeMatch[1] ?? ""),
    });
  }
  const authorityDenyMatch = url.pathname.match(
    /^\/authority-requests\/([^/]+)\/deny$/u,
  );
  if (method === "POST" && authorityDenyMatch) {
    return await callBridge<T>(bridge, "denyAuthorityRequest", {
      sessionId: url.searchParams.get("session_id") ?? undefined,
      requestRef: decodeURIComponent(authorityDenyMatch[1] ?? ""),
    });
  }
  const questionAnswerMatch = url.pathname.match(/^\/authority-requests\/([^/]+)\/answer$/u);
  if (method === "POST" && questionAnswerMatch) {
    return await callBridge<T>(bridge, "answerUserQuestions", {
      sessionId: url.searchParams.get("session_id") ?? undefined,
      requestRef: decodeURIComponent(questionAnswerMatch[1] ?? ""),
      response: parseBody(options.body),
    });
  }
  const authorityModifyMatch = url.pathname.match(
    /^\/authority-requests\/([^/]+)\/modify$/u,
  );
  if (method === "POST" && authorityModifyMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "modifyAuthorityRequest", {
      sessionId: url.searchParams.get("session_id") ?? undefined,
      requestRef: decodeURIComponent(authorityModifyMatch[1] ?? ""),
      alternative: body.alternative,
    });
  }
  if (method === "POST" && url.pathname === "/session-queue") {
    const body = parseBody(options.body);
    return unwrapBridgeResult<T>(await callBridge(bridge, "queueMessage", {
      chatId: body.chat_id,
      text: body.text,
      contentParts: body.content_parts,
      imageEdit: body.image_edit,
      model: body.model,
      reasoningEffort: body.reasoning_effort,
      accessMode: body.access_mode,
      planMode: body.plan_mode,
      attachments: body.attachments,
      traceparent,
    }));
  }
  const queuedSendNowMatch = url.pathname.match(/^\/session-queue\/([^/]+)\/send-now$/u);
  if (method === "POST" && queuedSendNowMatch) {
    return await callBridge<T>(bridge, "sendQueuedMessageNow", {
      queuedMessageId: decodeURIComponent(queuedSendNowMatch[1]!),
      traceparent,
    });
  }
  const queuedMessageMatch = url.pathname.match(/^\/session-queue\/([^/]+)$/u);
  if (method === "PATCH" && queuedMessageMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "updateQueuedMessage", {
      queuedMessageId: decodeURIComponent(queuedMessageMatch[1]!),
      text: body.text,
      contentParts: body.content_parts,
      imageEdit: body.image_edit,
      model: body.model,
      reasoningEffort: body.reasoning_effort,
      accessMode: body.access_mode,
      planMode: body.plan_mode,
      attachments: body.attachments,
    });
  }
  if (method === "DELETE" && queuedMessageMatch) {
    return await callBridge<T>(bridge, "deleteQueuedMessage", {
      queuedMessageId: decodeURIComponent(queuedMessageMatch[1]!),
    });
  }
  if (method === "GET" && url.pathname === "/turns") {
    return await callBridge<T>(bridge, "listTurns", {
      chatId: url.searchParams.get("chat_id") ?? "general",
      cursor: Number(url.searchParams.get("cursor") ?? "0"),
    });
  }
  if (method === "GET" && url.pathname === "/events") {
    return await callBridge<T>(bridge, "replayEvents", {
      cursor: Number(url.searchParams.get("cursor") ?? "0"),
    });
  }
  if (method === "POST" && url.pathname === "/messages") {
    const body = parseBody(options.body);
    return unwrapBridgeResult<T>(await callBridge(bridge, "sendMessage", {
      chatId: body.chat_id,
      text: body.text,
      clientMessageId: body.client_message_id,
      contentParts: body.content_parts,
      imageEdit: body.image_edit,
      model: body.model,
      reasoningEffort: body.reasoning_effort,
      accessMode: body.access_mode,
      planMode: body.plan_mode,
      queuePolicy: body.queue_policy,
      attachments: body.attachments,
      traceparent,
    }));
  }
  const retryMatch = method === "POST" ? url.pathname.match(/^\/turns\/([^/]+)\/retry$/) : null;
  if (retryMatch) return await callBridge<T>(bridge, "retryTurn", { turnId: decodeURIComponent(retryMatch[1]), traceparent });
  const retryCurrentMatch = method === "POST" ? url.pathname.match(/^\/turns\/([^/]+)\/retry-current$/) : null;
  if (retryCurrentMatch) {
    return await callBridge<T>(bridge, "retryTurnWithCurrentControls", { turnId: decodeURIComponent(retryCurrentMatch[1]), traceparent });
  }
  const cancelMatch = method === "POST" ? url.pathname.match(/^\/turns\/([^/]+)\/cancel$/) : null;
  if (cancelMatch) return await callBridge<T>(bridge, "cancelTurn", { turnId: decodeURIComponent(cancelMatch[1]), traceparent });
  const stewardCancelMatch = method === "POST"
    ? url.pathname.match(/^\/steward-relations\/([^/]+)\/cancel$/)
    : null;
  if (stewardCancelMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "cancelSteward", {
      relationId: decodeURIComponent(stewardCancelMatch[1]!),
      parentSessionId: body.parent_session_id,
    });
  }
  const stewardResumeMatch = method === "POST"
    ? url.pathname.match(/^\/steward-relations\/([^/]+)\/resume$/)
    : null;
  if (stewardResumeMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "resumeSteward", {
      relationId: decodeURIComponent(stewardResumeMatch[1]!),
      parentSessionId: body.parent_session_id,
    });
  }
  const stillDeliveryMatch = method === "GET" ? url.pathname.match(/^\/browser-stills\/([^/]+)$/u) : null;
  if (stillDeliveryMatch) return callBridge<T>(bridge, "getBrowserStills", {
    id: decodeURIComponent(stillDeliveryMatch[1]!), sessionId: url.searchParams.get("session_id"), wait: url.searchParams.get("wait") === "1",
  });
  const operationOutputMatch = method === "GET"
    ? url.pathname.match(/^\/turns\/([^/]+)\/operations\/([^/]+)\/output$/u)
    : null;
  if (operationOutputMatch) {
    return await callBridge<T>(bridge, "getOperationOutput", {
      turnId: decodeURIComponent(operationOutputMatch[1]!),
      requestId: decodeURIComponent(operationOutputMatch[2]!),
      resultId: url.searchParams.get("result_id"),
      offset: Number(url.searchParams.get("offset") ?? "0"),
    });
  }
  if (method === "GET" && url.pathname === "/automations") {
    return await callBridge<T>(bridge, "listAutomations", { targetSessionId: url.searchParams.get("target_session_id") ?? undefined });
  }
  if (method === "POST" && url.pathname === "/automations") {
    const body = parseBody(options.body);
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "createAutomation", {
      title: body.title,
      promptBody: body.prompt_body,
      targetSessionId: body.target_session_id,
      intervalSeconds: body.interval_seconds,
      accessMode: body.access_mode,
      model: body.model,
      schedule: body.schedule,
      scheduleType: body.schedule_type,
      runAt: body.run_at,
      startAt: body.start_at,
    }));
  }
  const automationMatch = url.pathname.match(/^\/automations\/([^/]+)$/);
  if (automationMatch && method === "GET") {
    return await callBridge<T>(bridge, "getAutomation", { automationId: decodeURIComponent(automationMatch[1]) });
  }
  if (automationMatch && method === "PATCH") {
    const body = parseBody(options.body);
    return unwrapBridgeResult<T>(await callBridge<BridgeResult<T> | T>(bridge, "updateAutomation", {
      automationId: decodeURIComponent(automationMatch[1]),
      title: body.title,
      promptBody: body.prompt_body,
      targetSessionId: body.target_session_id,
      intervalSeconds: body.interval_seconds,
      state: body.state,
      accessMode: body.access_mode,
      model: body.model,
      schedule: body.schedule,
      scheduleType: body.schedule_type,
      runAt: body.run_at,
      startAt: body.start_at,
    }));
  }
  if (automationMatch && method === "DELETE") {
    return await callBridge<T>(bridge, "deleteAutomation", { automationId: decodeURIComponent(automationMatch[1]) });
  }
  const automationActionMatch = method === "POST" ? url.pathname.match(/^\/automations\/([^/]+)\/(run|pause|resume)$/) : null;
  if (automationActionMatch) {
    const automationId = decodeURIComponent(automationActionMatch[1]);
    if (automationActionMatch[2] === "run") return await callBridge<T>(bridge, "runAutomation", { automationId });
    if (automationActionMatch[2] === "pause") return await callBridge<T>(bridge, "pauseAutomation", { automationId });
    return await callBridge<T>(bridge, "resumeAutomation", { automationId });
  }
  const automationRunsMatch = method === "GET" ? url.pathname.match(/^\/automations\/([^/]+)\/runs$/) : null;
  if (automationRunsMatch) return await callBridge<T>(bridge, "listAutomationRuns", { automationId: decodeURIComponent(automationRunsMatch[1]) });
  if (method === "POST" && url.pathname === "/automations/dispatch-due") return await callBridge<T>(bridge, "dispatchDueAutomations");
  if (method === "GET" && url.pathname === "/worker-activity") {
    return await callBridge<T>(bridge, "listWorkerActivity", {
      includeHistory: url.searchParams.get("include_history") === "true",
      limit: numericSearchParam(url.searchParams, "limit"),
      offset: numericSearchParam(url.searchParams, "offset"),
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
  }
  const sessionWorkerMatch = method === "GET" ? url.pathname.match(/^\/sessions\/([^/]+)\/worker-activity(?:\/history)?$/) : null;
  if (sessionWorkerMatch) {
    return await callBridge<T>(bridge, "listWorkerActivity", {
      sessionId: decodeURIComponent(sessionWorkerMatch[1]),
      includeHistory: url.pathname.endsWith("/history"),
      limit: numericSearchParam(url.searchParams, "limit"),
      offset: numericSearchParam(url.searchParams, "offset"),
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
  }
  const workerMatch = url.pathname.match(/^\/worker-activity\/([^/]+)$/);
  if (workerMatch && method === "GET") return await callBridge<T>(bridge, "getWorkerActivity", { workerId: decodeURIComponent(workerMatch[1]) });
  const workerControlMatch = method === "POST" ? url.pathname.match(/^\/worker-activity\/([^/]+)\/control$/) : null;
  if (workerControlMatch) {
    return await callBridge<T>(bridge, "controlWorkerActivity", {
      workerId: decodeURIComponent(workerControlMatch[1]),
      action: parseBody(options.body).action,
    });
  }
  throw new Error(`Unsupported Butler app API route: ${method} ${url.pathname}`);
}

export interface ProjectFolderPage {
  root_name: string;
  path: string;
  folders: Array<{ name: string }>;
  next_after: string | null;
}

export function listProjectFolders(path: string, after?: string): Promise<ProjectFolderPage> {
  const query = new URLSearchParams({ path });
  if (after !== undefined) query.set("after", after);
  return api<ProjectFolderPage>(`/project-folders?${query}`);
}

export interface ProjectFolderSelection {
  workspace_path?: string;
  cancelled?: boolean;
  display_name?: string;
  folder_path?: string;
  folder_selection_token?: string;
}

export async function selectProjectFolder(): Promise<ProjectFolderSelection> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (!bridge?.selectProjectFolder) {
    const error = new Error(appCopy.interfaceFeedback.desktopFolderOnly);
    Object.assign(error, { code: "project_folder_picker_unavailable" });
    throw error;
  }
  return await callBridge(bridge, "selectProjectFolder");
}

export async function getSessionFolderLaunchTargets(
  sessionId: string,
): Promise<SessionFolderLaunchTargetsResult> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.getSessionFolderLaunchTargets !== "function") {
    return {
      ok: false,
      code: "bridge_unavailable",
      recoverable: true,
      targets: [],
    };
  }
  return await bridge.getSessionFolderLaunchTargets({ sessionId });
}

export async function openSessionFolder(
  sessionId: string,
  target: SessionFolderLaunchTarget,
): Promise<SessionFolderLaunchResult> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.openSessionFolder !== "function") {
    return { ok: false, code: "bridge_unavailable", recoverable: true };
  }
  return await bridge.openSessionFolder({ sessionId, target });
}

export function canSelectProjectFolder(): boolean {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  return typeof bridge?.selectProjectFolder === "function";
}

export function isProjectFolderPickerUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "project_folder_picker_unavailable"
  );
}

/** The public error code of a failed App request, if the gateway sent one. */
export function apiErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SessionViewBridgeError };

/**
 * Unwrap a preload result envelope (see bridgeErrorEnvelope in preload.cjs).
 * contextBridge drops custom Error fields, so failures arrive as a bounded
 * code; the renderer turns that code into localized copy, never raw text.
 * Direct values pass through for browser/test bridge doubles.
 */
function unwrapBridgeResult<T>(value: BridgeResult<T> | T): T {
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "ok")) {
    return value as T;
  }
  const result = value as BridgeResult<T>;
  if (result.ok) return result.data;
  const code = typeof result.error?.code === "string" ? result.error.code : "request_failed";
  const hookReason = code === "hook_blocked" && typeof result.error?.hook_reason === "string" ? result.error.hook_reason : undefined;
  const error = new Error(hookReason ?? appCopy.serverErrors[code] ?? appCopy.interfaceFeedback.requestFailed);
  Object.assign(error, {
    code,
    ...(code === "tag_exists" && result.error?.existing ? { existing: result.error.existing } : {}),
    ...(Number.isSafeInteger(result.error?.current?.revision) ? { current: result.error.current } : {}),
    ...(typeof result.error?.status === "number" ? { status: result.error.status } : {}),
  });
  throw error;
}

const CODED_SETTINGS_METHODS = new Set([
  "uploadCanonFile",
  "listMcpServers", "createMcpServer", "probeMcpServer", "updateMcpServer", "deleteMcpServer",
  "importSkill", "discoverLocalModels", "registerLocalModel", "updateLocalModel",
]);

/** Settings → Browser → Sign-ins and browser import: main adds the admin credential. */
function signInBridgeCall(method: string, path: string, body: ApiOptions["body"]): { action: string; input?: unknown } | null {
  const payload = () => parseBody(body);
  if (path === "/security/oauth" && method === "GET") return { action: "listOauthCredentials" };
  const credential = path.match(/^\/security\/oauth\/([^/]+)$/u)?.[1];
  if (credential && method === "DELETE") return { action: "removeOauthCredential", input: { id: decodeURIComponent(credential) } };
  if (path === "/security/signins") return method === "GET" ? { action: "listSignIns" } : method === "POST" ? { action: "addSignIn", input: payload() } : null;
  if (path === "/security/signins/site" && method === "POST") return { action: "updateSignInSite", input: payload() };
  const entry = path.match(/^\/security\/signins\/([0-9a-f-]{36})$/u)?.[1];
  if (entry && method === "PATCH") return { action: "updateSignIn", input: { id: entry, payload: payload() } };
  if (entry && method === "DELETE") return { action: "deleteSignIn", input: { id: entry } };
  if (path === "/security/browser-import/sources" && method === "GET") return { action: "listImportSources" };
  if (path === "/security/browser-import/preview" && method === "POST") return { action: "previewImport", input: payload() };
  if (path === "/security/browser-import/run" && method === "POST") return { action: "runImport", input: payload() };
  if (path === "/security/browser-import/start" && method === "POST") return { action: "startBrowserImport", input: payload() };
  if (path === "/security/browser-import/undo" && method === "POST") return { action: "undoBrowserImport", input: payload() };
  if (path === "/security/browser-import/folder" && method === "POST") return { action: "pickBrowserImportFolder", input: payload() };
  if (path === "/security/browser-import/disk-access" && method === "POST") return { action: "openBrowserImportDiskAccess", input: payload() };
  if (path === "/security/browser-import/export" && method === "POST") return { action: "beginBrowserPasswordExport", input: payload() };
  if (path === "/security/browser-import/export/poll" && method === "POST") return { action: "pollBrowserPasswordExport", input: payload() };
  if (path === "/security/browser-import/export/file" && method === "POST") return { action: "chooseBrowserPasswordExport", input: payload() };
  if (path === "/security/browser-import/export/delete" && method === "POST") return { action: "deleteBrowserPasswordExport", input: payload() };
  if (path === "/security/browser-import/export/cancel" && method === "POST") return { action: "cancelBrowserPasswordExport", input: payload() };
  if (path === "/security/agent-import/sources" && method === "GET") return { action: "listAgentImportSources" };
  if (path === "/security/agent-import/start" && method === "POST") return { action: "startAgentImport", input: payload() };
  if (path === "/security/agent-import/undo" && method === "POST") return { action: "undoAgentImport", input: payload() };
  return vaultBridgeCall(method, path, payload);
}

/** Settings → Browser → Payment methods and Profile details: main adds the admin credential. */
function vaultBridgeCall(method: string, path: string, payload: () => unknown): { action: string; input?: unknown } | null {
  if (path === "/security/vault") return method === "GET" ? { action: "listVault" } : null;
  if (path === "/security/vault/purchase-sites" && method === "POST") return { action: "setPurchaseSite", input: payload() };
  const match = path.match(/^\/security\/vault\/(cards|profiles)(?:\/([0-9a-f-]{36})(?:\/(reveal|sites))?)?$/u);
  if (!match) return null;
  const [, kind, id, suffix] = match;
  const noun = kind === "cards" ? "Card" : "Profile";
  if (!id) return method === "POST" ? { action: `add${noun}`, input: payload() } : null;
  if (!suffix && method === "PATCH") return { action: `update${noun}`, input: { id, payload: payload() } };
  if (!suffix && method === "DELETE") return { action: `delete${noun}`, input: { id } };
  if (suffix === "sites" && method === "POST") return { action: `set${noun}Site`, input: { id, payload: payload() } };
  if (suffix === "reveal" && method === "POST") return { action: `reveal${noun}`, input: { id, payload: payload() } };
  return null;
}

export async function callBridge<T>(bridge: ButlerAppBridge, method: string, input?: unknown): Promise<T> {
  const fn = bridge[method];
  if (typeof fn !== "function") throw new Error(`Butler desktop bridge is missing ${method}.`);
  const value = await fn(input);
  return CODED_SETTINGS_METHODS.has(method) ? unwrapBridgeResult<T>(value as BridgeResult<T> | T) : value as T;
}

/**
 * Unwrap the serializable preload result for the canonical session-view path.
 * The direct-value fallback keeps browser/test bridge doubles compatible while
 * the production Electron preload always returns the discriminated envelope.
 */
function unwrapSessionViewBridgeResult<T>(value: SessionViewBridgeResult | T): T {
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "ok")) {
    return value as T;
  }
  const result = value as SessionViewBridgeResult;
  if (result.ok) return result.data as T;
  if (
    !result.error ||
    result.error.schema !== "butler.app.bridge-error.v1" ||
    typeof result.error.code !== "string"
  ) {
    throw new Error("Butler desktop returned an invalid session-view result.");
  }
  const isResync = result.error.resync?.required === true ||
    result.error.code === "session_cursor_resync_required";
  const error = new Error(
    isResync
      ? "Session view must be resynchronized."
      : "Butler desktop request failed.",
  );
  Object.assign(error, {
    code: result.error.code,
    ...(typeof result.error.status === "number" ? { status: result.error.status } : {}),
    ...(result.error.resync ? { resync: result.error.resync } : {}),
  });
  throw error;
}

function parseBody(body: ApiOptions["body"]): Record<string, unknown> {
  if (typeof body === "string") return JSON.parse(body);
  if (body && typeof body === "object") return body as Record<string, unknown>;
  return {};
}

function paginationRequest(
  searchParams: URLSearchParams,
): { limit?: number; offset?: number } {
  return {
    limit: numericSearchParam(searchParams, "limit"),
    offset: numericSearchParam(searchParams, "offset"),
  };
}

function numericSearchParam(
  searchParams: URLSearchParams,
  key: string,
): number | undefined {
  const value = searchParams.get(key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

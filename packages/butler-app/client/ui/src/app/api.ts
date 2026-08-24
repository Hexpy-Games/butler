import type {
  AppInfoView,
  MessageFileRef,
  SettingsView,
  SkillImportResult,
  TimelineEvent,
  SessionView,
  SessionViewBridgeInput,
  SessionViewBridgeResult,
} from "./types.ts";

declare global {
  interface Window {
    butlerApp?: ButlerAppBridge;
  }
}

interface ButlerAppBridge {
  protocolVersion?: string;
  serverUrl?: string;
  platform?: string;
  saveMessageFile?: (input?: unknown) => Promise<unknown>;
  showDesktopNotification?: (input?: unknown) => Promise<unknown>;
  getNativeNotificationStatus?: () => Promise<unknown>;
  testDesktopNotification?: () => Promise<unknown>;
  getSessionView?: (
    input?: SessionViewBridgeInput,
  ) => Promise<SessionViewBridgeResult | SessionView>;
  getAuthorityRequests?: (input?: unknown) => Promise<unknown>;
  allowAuthorityRequest?: (input?: unknown) => Promise<unknown>;
  denyAuthorityRequest?: (input?: unknown) => Promise<unknown>;
  modifyAuthorityRequest?: (input?: unknown) => Promise<unknown>;
  openNativeNotificationSettings?: () => Promise<unknown>;
  setNativeShellPreferences?: (input?: unknown) => Promise<unknown>;
  subscribeLiveEvents?: (
    input?: { cursor?: number },
    handlers?: {
      onEvent?: (event: TimelineEvent) => void;
      onError?: (error: unknown) => void;
    },
  ) => (() => void) | void;
  onNativeNavigation?: (
    handler: (request: unknown) => void,
  ) => (() => void) | Promise<() => void>;
  [method: string]: unknown;
}

type ApiOptions = RequestInit & { body?: BodyInit | Record<string, unknown> | null };

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
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
  if (!response.ok) throw new Error(payload?.error?.message ?? "File upload failed.");
  return payload.data.file as MessageFileRef;
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
  if (!response.ok) throw new Error(payload?.error?.message ?? "Skill import failed.");
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
): () => void {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.subscribeLiveEvents === "function") {
    const unsubscribe = bridge.subscribeLiveEvents(
      { cursor },
      { onEvent, onError },
    );
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }
  if (typeof EventSource === "undefined") {
    onError(new Error("Live event stream is unavailable in this browser."));
    return () => {};
  }
  const liveSource = new EventSource(liveEventsUrl(cursor));
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
      const error = new Error(body.error?.message ?? "Request failed.");
      Object.assign(error, {
        ...(typeof body.error?.code === "string" ? { code: body.error.code } : {}),
        status: response.status,
      });
      throw error;
    }
    return body.data as T;
  });
}

async function bridgeRequest<T>(bridge: ButlerAppBridge, path: string, options: ApiOptions = {}): Promise<T> {
  const method = String(options.method ?? "GET").toUpperCase();
  const url = new URL(path, window.location.origin);
  if (method === "GET" && url.pathname === "/health") return await callBridge<T>(bridge, "health");
  if (method === "GET" && url.pathname === "/setup/status") return await callBridge<T>(bridge, "getSetupStatus");
  if (method === "POST" && url.pathname === "/setup/start") return await callBridge<T>(bridge, "startSetup", parseBody(options.body));
  if (method === "POST" && url.pathname === "/setup/cancel") return await callBridge<T>(bridge, "cancelSetup", parseBody(options.body));
  if (method === "GET" && url.pathname === "/setup/diagnostics") return await callBridge<T>(bridge, "exportSetupDiagnostics");
  if (method === "GET" && url.pathname === "/chats") return await callBridge<T>(bridge, "listChats");
  if (method === "GET" && url.pathname === "/navigation") return await callBridge<T>(bridge, "listNavigation");
  if (method === "GET" && url.pathname === "/new-chat-briefing") {
    return await callBridge<T>(bridge, "getNewChatBriefing", {
      date: url.searchParams.get("date") ?? undefined,
      projectId: url.searchParams.get("project_id") ?? undefined,
    });
  }
  if (method === "GET" && url.pathname === "/settings") return await callBridge<T>(bridge, "getSettings");
  if (method === "GET" && url.pathname === "/app-info") return await callBridge<T>(bridge, "getAppInfo");
  if (method === "GET" && url.pathname === "/updates") return await callBridge<T>(bridge, "getUpdates");
  if (method === "POST" && url.pathname === "/updates/check") {
    return await callBridge<T>(bridge, "checkUpdates", parseBody(options.body));
  }
  if (method === "POST" && url.pathname === "/updates/apply") {
    return await callBridge<T>(bridge, "applyUpdate", parseBody(options.body));
  }
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
  if (method === "PATCH" && url.pathname === "/settings") return await callBridge<T>(bridge, "updateSettings", parseBody(options.body));
  if (method === "GET" && url.pathname === "/command-palette") {
    return await callBridge<T>(bridge, "searchCommandPalette", { query: url.searchParams.get("query") ?? "" });
  }
  if (method === "GET" && url.pathname === "/archives") {
    return await callBridge<T>(bridge, "listArchives", paginationRequest(url.searchParams));
  }
  if (method === "GET" && url.pathname === "/system-events") {
    return await callBridge<T>(bridge, "listSystemEvents", paginationRequest(url.searchParams));
  }
  if (method === "GET" && url.pathname === "/developer-logs") {
    return await callBridge<T>(bridge, "listDeveloperLogs", {
      ...paginationRequest(url.searchParams),
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
      turnId: url.searchParams.get("turn_id") ?? url.searchParams.get("turnId"),
      kind: url.searchParams.get("kind") ?? undefined,
      query: url.searchParams.get("query") ?? undefined,
    });
  }
  if (method === "GET" && url.pathname === "/usage-monitor") {
    return await callBridge<T>(bridge, "getUsageMonitor", {
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
      sinceHours: numericSearchParam(url.searchParams, "since_hours") ??
        numericSearchParam(url.searchParams, "sinceHours"),
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
  if (method === "GET" && url.pathname === "/artifacts") {
    return await callBridge<T>(bridge, "listArtifacts", {
      sessionId: url.searchParams.get("session_id") ?? url.searchParams.get("sessionId"),
    });
  }
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
      projectId: body.project_id,
      sessionHint: body.session_hint,
      idempotencyKey: body.idempotency_key,
    });
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
    return await callBridge<T>(bridge, "queueMessage", {
      chatId: body.chat_id,
      text: body.text,
      model: body.model,
      reasoningEffort: body.reasoning_effort,
      accessMode: body.access_mode,
      planMode: body.plan_mode,
      attachments: body.attachments,
    });
  }
  const queuedMessageMatch = url.pathname.match(/^\/session-queue\/([^/]+)$/u);
  if (method === "PATCH" && queuedMessageMatch) {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "updateQueuedMessage", {
      queuedMessageId: decodeURIComponent(queuedMessageMatch[1]!),
      text: body.text,
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
    return await callBridge<T>(bridge, "sendMessage", {
      chatId: body.chat_id,
      text: body.text,
      clientMessageId: body.client_message_id,
      model: body.model,
      reasoningEffort: body.reasoning_effort,
      accessMode: body.access_mode,
      planMode: body.plan_mode,
      queuePolicy: body.queue_policy,
      attachments: body.attachments,
    });
  }
  const retryMatch = method === "POST" ? url.pathname.match(/^\/turns\/([^/]+)\/retry$/) : null;
  if (retryMatch) return await callBridge<T>(bridge, "retryTurn", { turnId: decodeURIComponent(retryMatch[1]) });
  const retryCurrentMatch = method === "POST" ? url.pathname.match(/^\/turns\/([^/]+)\/retry-current$/) : null;
  if (retryCurrentMatch) return await callBridge<T>(bridge, "retryTurnWithCurrentControls", { turnId: decodeURIComponent(retryCurrentMatch[1]) });
  const cancelMatch = method === "POST" ? url.pathname.match(/^\/turns\/([^/]+)\/cancel$/) : null;
  if (cancelMatch) return await callBridge<T>(bridge, "cancelTurn", { turnId: decodeURIComponent(cancelMatch[1]) });
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
    return await callBridge<T>(bridge, "createAutomation", {
      title: body.title,
      promptBody: body.prompt_body,
      targetSessionId: body.target_session_id,
      intervalSeconds: body.interval_seconds,
    });
  }
  const automationMatch = url.pathname.match(/^\/automations\/([^/]+)$/);
  if (automationMatch && method === "GET") {
    return await callBridge<T>(bridge, "getAutomation", { automationId: decodeURIComponent(automationMatch[1]) });
  }
  if (automationMatch && method === "PATCH") {
    const body = parseBody(options.body);
    return await callBridge<T>(bridge, "updateAutomation", {
      automationId: decodeURIComponent(automationMatch[1]),
      title: body.title,
      promptBody: body.prompt_body,
      targetSessionId: body.target_session_id,
      intervalSeconds: body.interval_seconds,
      state: body.state,
    });
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

export async function selectProjectFolder(): Promise<{ cancelled?: boolean; display_name?: string; folder_selection_token?: string }> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (!bridge?.selectProjectFolder) {
    const error = new Error("Project folder picker is only available in the desktop app.");
    Object.assign(error, { code: "project_folder_picker_unavailable" });
    throw error;
  }
  return await callBridge(bridge, "selectProjectFolder");
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

async function callBridge<T>(bridge: ButlerAppBridge, method: string, input?: unknown): Promise<T> {
  const fn = bridge[method];
  if (typeof fn !== "function") throw new Error(`Butler desktop bridge is missing ${method}.`);
  return await fn(input) as T;
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

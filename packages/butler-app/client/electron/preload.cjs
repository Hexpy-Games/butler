const { contextBridge, ipcRenderer } = require("electron");

const port = Number(process.env.BUTLER_APP_SERVER_PORT ?? "18765");
let cachedServerUrl = normalizeLocalServerUrl(
  process.env.BUTLER_APP_SERVER_URL ??
    `http://127.0.0.1:${Number.isFinite(port) ? port : 18765}`,
);
const messageCacheSchema = "butler.message-cache.v1";
const messageCachePrefix = "butler:message-cache:v1:";
const appUiStateSchema = "butler.app-ui-state.v1";
const appUiStateKey = "butler:app-ui-state:v1";
// Sandboxed preloads cannot load arbitrary Node modules or JSON files. The
// main process validates the shared JSON artifact and passes this typed,
// bounded value through BrowserWindow.additionalArguments instead.
const cacheBudgetArgumentPrefix = "--butler-cache-budget=";
const disabledCacheBudget = Object.freeze({
  schema: "butler.app.cache-budget.v1",
  maxEntries: 0,
  maxBytes: 0,
  maxSnapshotBytes: 0,
  maxMessages: 0,
  maxComposerDraftBytes: 0,
  maxComposerDraftEntries: 0,
  maxComposerDraftAggregateBytes: 0,
});
const bridgeErrorSchema = "butler.app.bridge-error.v1";
const safeBridgeCodePattern = /^[a-z][a-z0-9_]{1,63}$/u;

function safeBridgeCode(value) {
  return typeof value === "string" && safeBridgeCodePattern.test(value)
    ? value
    : "request_failed";
}

function safeBridgeStatus(value) {
  const status = Number(value);
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/**
 * A rejected preload promise crosses Electron's contextBridge as a plain
 * Error, which drops custom fields such as `code` and `status`. Public
 * session-view calls therefore return this bounded, serializable envelope
 * instead of throwing. Do not include response text, paths, or credentials.
 */
function bridgeErrorEnvelope(error) {
  const code = safeBridgeCode(error && error.code);
  const status = safeBridgeStatus(error && error.status);
  return {
    schema: bridgeErrorSchema,
    code,
    ...(status === undefined ? {} : { status }),
    ...(code === "session_cursor_resync_required"
      ? {
          resync: {
            required: true,
            resource: "session-view",
            reason: "cursor-expired",
          },
        }
      : {}),
  };
}

async function requestBridgeResult(path, options = {}) {
  try {
    return { ok: true, data: await requestJson(path, options) };
  } catch (error) {
    return { ok: false, error: bridgeErrorEnvelope(error) };
  }
}

function isBoundedCacheInteger(value, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}
function normalizeMessageCacheBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== disabledCacheBudget.schema) return disabledCacheBudget;
  if (value.maxEntries === 0 && value.maxBytes === 0 &&
      value.maxSnapshotBytes === 0 && value.maxMessages === 0 &&
      value.maxComposerDraftBytes === 0 && value.maxComposerDraftEntries === 0 &&
      value.maxComposerDraftAggregateBytes === 0) {
    return disabledCacheBudget;
  }
  if (!isBoundedCacheInteger(value.maxEntries, 64) ||
      !isBoundedCacheInteger(value.maxBytes, 128 * 1024 * 1024) ||
      !isBoundedCacheInteger(value.maxSnapshotBytes, 8 * 1024 * 1024) ||
      !isBoundedCacheInteger(value.maxMessages, 10_000) ||
      !isBoundedCacheInteger(value.maxComposerDraftBytes, 256 * 1024) ||
      !isBoundedCacheInteger(value.maxComposerDraftEntries, 64) ||
      !isBoundedCacheInteger(value.maxComposerDraftAggregateBytes, 16 * 1024 * 1024) ||
      value.maxSnapshotBytes > value.maxBytes) return disabledCacheBudget;
  return Object.freeze({
    schema: disabledCacheBudget.schema,
    maxEntries: value.maxEntries,
    maxBytes: value.maxBytes,
    maxSnapshotBytes: value.maxSnapshotBytes,
    maxMessages: value.maxMessages,
    maxComposerDraftBytes: value.maxComposerDraftBytes,
    maxComposerDraftEntries: value.maxComposerDraftEntries,
    maxComposerDraftAggregateBytes: value.maxComposerDraftAggregateBytes,
  });
}
function cacheBudgetFromArguments(argv) {
  const argument = argv.find((candidate) =>
    typeof candidate === "string" && candidate.startsWith(cacheBudgetArgumentPrefix));
  if (!argument) return disabledCacheBudget;
  try {
    return normalizeMessageCacheBudget(JSON.parse(decodeURIComponent(
      argument.slice(cacheBudgetArgumentPrefix.length),
    )));
  } catch {
    return disabledCacheBudget;
  }
}
const messageCacheBudget = cacheBudgetFromArguments(process.argv);
const messageCacheMemory = hydrateMessageCacheFromLocalStorage();

function normalizeLocalServerUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("Butler app server URL must be a local http origin.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function requestJson(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  await ensureLocalServer();
  const serverUrl = await currentServerUrl();
  const authHeaders = await localAuthHeaders();
  const response = await fetch(new URL(path, serverUrl), {
    ...options,
    headers: {
      ...(options.body && !isFormData ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
      ...authHeaders,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `Request failed with status ${response.status}.`);
    error.code = body?.error?.code ?? "request_failed";
    error.status = response.status;
    throw error;
  }
  if (!body || body.protocol_version !== "butler.app.v1") {
    const error = new Error("App server returned an invalid protocol envelope.");
    error.code = "invalid_protocol";
    error.status = response.status;
    throw error;
  }
  return body.data;
}

async function ensureLocalServer() {
  await ipcRenderer.invoke("butler:ensure-server");
}

async function currentServerUrl() {
  try {
    const value = await ipcRenderer.invoke("butler:get-server-url");
    if (typeof value === "string") {
      cachedServerUrl = normalizeLocalServerUrl(value);
    }
  } catch {
    // Keep the initial server URL when the dynamic bridge is unavailable.
  }
  return cachedServerUrl;
}

async function localAuthHeaders() {
  try {
    const headers = await ipcRenderer.invoke("butler:get-local-auth-headers");
    const authorization =
      headers && typeof headers === "object" && !Array.isArray(headers) &&
      typeof headers.authorization === "string"
        ? headers.authorization
        : "";
    return authorization ? { authorization } : {};
  } catch {
    return {};
  }
}

function liveEventsPath(cursor = 0) {
  const parsed = Number(cursor);
  const safeCursor = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : 0;
  return `/events/live?cursor=${safeCursor}`;
}

function parseSseRecord(record) {
  const dataLines = [];
  for (const rawLine of record.split(/\r\n|\n|\r/u)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    if (field !== "data") continue;
    const value = separator === -1 ? "" : rawLine.slice(separator + 1);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (dataLines.length === 0) return null;
  return JSON.parse(dataLines.join("\n"));
}

function drainSseRecords(buffer, onEvent) {
  let remaining = buffer;
  while (true) {
    const match = /(?:\r\n\r\n|\n\n|\r\r)/u.exec(remaining);
    if (!match) return remaining;
    const record = remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);
    if (!record.trim()) continue;
    const event = parseSseRecord(record);
    if (event) onEvent(event);
  }
}

function liveEventErrorPayload(error) {
  return {
    message: error?.message || "Live event stream failed.",
    code: error?.code || "live_events_failed",
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
  };
}

function subscribeLiveEvents({ cursor = 0 } = {}, handlers = {}) {
  const onEvent = typeof handlers?.onEvent === "function"
    ? handlers.onEvent
    : () => {};
  const onError = typeof handlers?.onError === "function"
    ? handlers.onError
    : () => {};
  const abortController = new AbortController();
  let closed = false;
  let reader;

  async function run() {
    try {
      await ensureLocalServer();
      const serverUrl = await currentServerUrl();
      const authHeaders = await localAuthHeaders();
      const response = await fetch(new URL(liveEventsPath(cursor), serverUrl), {
        headers: {
          accept: "text/event-stream",
          ...authHeaders,
        },
        signal: abortController.signal,
      });
      if (!response.ok) {
        const error = new Error(`Live event stream failed with status ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      if (!response.body) {
        throw new Error("Live event stream response did not include a body.");
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = drainSseRecords(
          buffer + decoder.decode(value, { stream: true }),
          onEvent,
        );
      }
      buffer = drainSseRecords(buffer + decoder.decode(), onEvent);
      if (!closed) {
        throw new Error("Live event stream ended before it was cancelled.");
      }
    } catch (error) {
      if (!closed && error?.name !== "AbortError") {
        onError(liveEventErrorPayload(error));
      }
    } finally {
      try {
        const activeReader = reader;
        try {
          await activeReader?.cancel();
        } finally {
          // cancel() settles the body but does not release the stream lock.
          // Always release after the pending read has settled so reconnects
          // cannot retain a reader/listener on the old response.
          activeReader?.releaseLock();
          if (reader === activeReader) reader = undefined;
        }
      } catch {
        // The response may already have completed or been aborted.
      }
      reader = undefined;
    }
  }

  void run();
  return () => {
    closed = true;
    abortController.abort();
    void reader?.cancel().catch(() => undefined);
  };
}

function messageCacheKey(chatId) {
  return `${messageCachePrefix}${encodeURIComponent(String(chatId || "general"))}`;
}

function hydrateMessageCacheFromLocalStorage() {
  const cache = new Map();
  const candidates = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return cache;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(messageCachePrefix)) continue;
      const snapshot = JSON.parse(storage.getItem(key) ?? "null");
      if (snapshot?.schema !== messageCacheSchema || !snapshot?.chat_id) continue;
      const bounded = boundedMessageCacheSnapshot(snapshot);
      if (!bounded) {
        storage.removeItem(key);
        continue;
      }
      const bytes = cacheEntryBytes(bounded);
      if (!Number.isFinite(bytes) || bytes > messageCacheBudget.maxSnapshotBytes) {
        storage.removeItem(key);
        continue;
      }
      candidates.push({ chatId: bounded.chat_id, snapshot: bounded, bytes });
    }
    candidates
      .sort((left, right) => {
        const timestamp = Date.parse(left.snapshot.cached_at) - Date.parse(right.snapshot.cached_at);
        return timestamp || left.chatId.localeCompare(right.chatId);
      })
      .forEach(({ chatId, snapshot, bytes }) => cache.set(chatId, { snapshot, bytes }));
    evictMessageCache(cache);
  } catch {
    // Cache hydration is opportunistic and must not block app startup.
  }
  return cache;
}

function readMessageCache(chatId) {
  const record = messageCacheMemory.get(chatId);
  if (!record) return null;
  messageCacheMemory.delete(chatId);
  messageCacheMemory.set(chatId, record);
  return record.snapshot;
}

function writeMessageCache(chatId, snapshot) {
  const bounded = boundedMessageCacheSnapshot(snapshot);
  if (!bounded || bounded.chat_id !== chatId) {
    return { ok: false };
  }
  const bytes = cacheEntryBytes(bounded);
  if (!Number.isFinite(bytes) || bytes > messageCacheBudget.maxSnapshotBytes) {
    return { ok: false };
  }
  messageCacheMemory.delete(chatId);
  messageCacheMemory.set(chatId, { snapshot: bounded, bytes });
  evictMessageCache(messageCacheMemory, chatId);
  try {
    if (messageCacheMemory.has(chatId)) {
      globalThis.localStorage?.setItem(messageCacheKey(chatId), JSON.stringify(bounded));
    } else {
      globalThis.localStorage?.removeItem(messageCacheKey(chatId));
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function cacheEntryBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedMessageCacheSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== messageCacheSchema ||
      typeof snapshot.chat_id !== "string" || !snapshot.chat_id ||
      !Array.isArray(snapshot.messages) ||
      !Number.isInteger(messageCacheBudget.maxMessages) ||
      messageCacheBudget.maxMessages <= 0) {
    return null;
  }
  // Durable cache is a completed rehydration window. Active/retry rows remain
  // in the live store but are never serialized into localStorage/preload Map.
  const messages = snapshot.messages.filter((message) => {
    const status = message && typeof message === "object" ? message.status : undefined;
    return status !== "pending" && status !== "thinking" &&
      status !== "streaming" && status !== "retrying";
  }).slice(-messageCacheBudget.maxMessages);
  if (messages.length === 0) return null;
  const retainedIds = new Set(messages.map((message) =>
    message && typeof message === "object" && typeof message.turn_id === "string"
      ? message.turn_id
      : null,
  ).filter(Boolean));
  const progress = snapshot.turn_progress && typeof snapshot.turn_progress === "object" &&
      !Array.isArray(snapshot.turn_progress)
    ? Object.fromEntries(Object.entries(snapshot.turn_progress).filter(([turnId, value]) => {
      const state = value && typeof value === "object" ? value.state : undefined;
      return retainedIds.has(turnId) && state !== "thinking" && state !== "running" &&
        state !== "streaming" && state !== "retrying";
    }))
    : {};
  return {
    schema: messageCacheSchema,
    chat_id: snapshot.chat_id,
    messages,
    turn_progress: progress,
    ...(Number.isFinite(Number(snapshot.next_cursor))
      ? { next_cursor: Number(snapshot.next_cursor) }
      : {}),
    ...(typeof snapshot.next_cursor_token === "string"
      ? { next_cursor_token: snapshot.next_cursor_token }
      : {}),
    cached_at: typeof snapshot.cached_at === "string"
      ? snapshot.cached_at
      : new Date().toISOString(),
  };
}

function evictMessageCache(cache, protectedChatId) {
  let totalBytes = [...cache.values()].reduce((total, record) => total + record.bytes, 0);
  while (cache.size > messageCacheBudget.maxEntries || totalBytes > messageCacheBudget.maxBytes) {
    const candidate = [...cache.keys()].find((chatId) => chatId !== protectedChatId);
    if (!candidate) break;
    const record = cache.get(candidate);
    if (!record) break;
    totalBytes -= record.bytes;
    cache.delete(candidate);
    try {
      globalThis.localStorage?.removeItem(messageCacheKey(candidate));
    } catch {
      // localStorage cleanup is best effort.
    }
  }
}

function readAppUiStateCache() {
  try {
    const raw = globalThis.localStorage?.getItem(appUiStateKey);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (snapshot?.schema !== appUiStateSchema) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function writeAppUiStateCache(snapshot) {
  if (!snapshot || snapshot.schema !== appUiStateSchema) return { ok: false };
  try {
    globalThis.localStorage?.setItem(appUiStateKey, JSON.stringify(snapshot));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

const butlerApp = Object.freeze({
  protocolVersion: "butler.app.v1",
  get serverUrl() {
    return cachedServerUrl;
  },
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke("butler:get-app-info"),
  setDeveloperMode: ({ enabled } = {}) =>
    ipcRenderer.invoke("butler:set-developer-mode", { enabled }),
  health: () => requestJson("/health"),
  getSetupStatus: () => ipcRenderer.invoke("butler:first-run-setup-status"),
  startSetup: (request = {}) =>
    ipcRenderer.invoke("butler:first-run-setup-start", request ?? {}),
  cancelSetup: (request = {}) =>
    ipcRenderer.invoke("butler:first-run-setup-cancel", request ?? {}),
  exportSetupDiagnostics: () =>
    ipcRenderer.invoke("butler:first-run-setup-diagnostics"),
  getAgentServiceStatus: () => ipcRenderer.invoke("butler:agent-service-status"),
  installAgentService: (request = {}) =>
    ipcRenderer.invoke("butler:agent-service-install", request ?? {}),
  startAgentService: (request = {}) =>
    ipcRenderer.invoke("butler:agent-service-start", request ?? {}),
  stopAgentService: (request = {}) =>
    ipcRenderer.invoke("butler:agent-service-stop", request ?? {}),
  restartAgentService: (request = {}) =>
    ipcRenderer.invoke("butler:agent-service-restart", request ?? {}),
  prepareAgentRuntimeUpdate: (request = {}) =>
    ipcRenderer.invoke("butler:agent-runtime-update-prepare", request ?? {}),
  applyAgentRuntimeUpdate: (request = {}) =>
    ipcRenderer.invoke("butler:agent-runtime-update-apply", request ?? {}),
  rollbackAgentRuntimeUpdate: (request = {}) =>
    ipcRenderer.invoke("butler:agent-runtime-update-rollback", request ?? {}),
  exportAgentServiceDiagnostics: () =>
    ipcRenderer.invoke("butler:agent-service-diagnostics"),
  quitApp: (input = {}) => ipcRenderer.invoke("butler:quit-app", {
    confirmed: input?.confirmed === true,
  }),
  quitAndInstallUpdate: () =>
    ipcRenderer.invoke("butler:quit-and-install-update"),
  minimizeWindow: () => ipcRenderer.invoke("butler:window-minimize"),
  toggleWindowMaximize: () =>
    ipcRenderer.invoke("butler:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("butler:window-close"),
  getSessionFolderLaunchTargets: ({ sessionId } = {}) =>
    ipcRenderer.invoke("butler:get-session-folder-launch-targets", {
      sessionId,
    }),
  openSessionFolder: ({ sessionId, target } = {}) =>
    ipcRenderer.invoke("butler:open-session-folder", {
      sessionId,
      target,
    }),
  listChats: () => requestJson("/chats"),
  listNavigation: () => requestJson("/navigation"),
  getNewChatBriefing: ({ date, projectId } = {}) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (projectId) params.set("project_id", projectId);
    const query = params.toString();
    return requestJson(query ? `/new-chat-briefing?${query}` : "/new-chat-briefing");
  },
  getUpdates: () => requestJson("/updates"),
  checkUpdates: (request = {}) => requestJson("/updates/check", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  applyUpdate: async (request = {}) => {
    const result = await requestJson("/updates/apply", {
      method: "POST",
      body: JSON.stringify(request ?? {}),
    });
    if (
      result?.component === "app" &&
      result?.stage_status === "staged" &&
      typeof result?.artifact_path === "string" &&
      result.artifact_path.trim()
    ) {
      await ipcRenderer.invoke("butler:open-update-artifact", {
        artifactPath: result.artifact_path,
      });
    }
    return result;
  },
  listProjects: ({ includeSessions = false } = {}) => {
    const params = new URLSearchParams({
      include_sessions: includeSessions ? "true" : "false",
    });
    return requestJson(`/projects?${params.toString()}`);
  },
  createProject: ({ source, displayName, folderSelectionToken, idempotencyKey }) => requestJson("/projects", {
    method: "POST",
    body: JSON.stringify({
      source,
      display_name: displayName,
      folder_selection_token: folderSelectionToken,
      idempotency_key: idempotencyKey,
    }),
  }),
  updateProject: ({ projectId, displayName, pinned, archived }) => requestJson(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      display_name: displayName,
      pinned,
      archived,
    }),
  }),
  archiveProject: ({ projectId }) => requestJson(`/projects/${encodeURIComponent(projectId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  pinProject: ({ projectId, pinned }) => requestJson(`/projects/${encodeURIComponent(projectId)}/pin`, {
    method: "POST",
    body: JSON.stringify({ pinned }),
  }),
  deleteProject: ({ projectId }) => requestJson(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  }),
  deleteProjectPermanent: ({ projectId }) => requestJson(`/projects/${encodeURIComponent(projectId)}?permanent=true`, {
    method: "DELETE",
  }),
  getProjectDashboard: ({ projectId }) => requestJson(`/projects/${encodeURIComponent(projectId)}/dashboard`),
  selectProjectFolder: () => ipcRenderer.invoke("butler:select-project-folder"),
  listSessions: ({ kind, projectId } = {}) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (projectId) params.set("project_id", projectId);
    const query = params.toString();
    return requestJson(query ? `/sessions?${query}` : "/sessions");
  },
  createSession: ({ kind, title, initialMessage, projectId, sessionHint, idempotencyKey }) => requestJson("/sessions", {
    method: "POST",
    body: JSON.stringify({
      kind,
      title,
      initial_message: initialMessage,
      project_id: projectId,
      session_hint: sessionHint,
      idempotency_key: idempotencyKey,
    }),
  }),
  updateSession: ({ sessionId, title, archived }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      title,
      archived,
    }),
  }),
  archiveSession: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  deleteSessionPermanent: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}?permanent=true`, {
    method: "DELETE",
  }),
  getSessionControls: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/controls`),
  updateSessionControls: ({ sessionId, controls }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/controls`, {
    method: "PATCH",
    body: JSON.stringify(controls ?? {}),
  }),
  listProjectSessions: ({ projectId } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    const query = params.toString();
    return requestJson(query ? `/project-sessions?${query}` : "/project-sessions");
  },
  listMessages: ({ chatId = "general", cursor = 0 } = {}) => {
    const params = new URLSearchParams({
      chat_id: chatId,
      cursor: String(Number.isFinite(Number(cursor)) ? Number(cursor) : 0),
    });
    return requestJson(`/messages?${params.toString()}`);
  },
  readCachedMessages: ({ chatId = "general" } = {}) => readMessageCache(chatId),
  writeCachedMessages: ({ chatId = "general", snapshot } = {}) => writeMessageCache(chatId, snapshot),
  readCachedAppUiState: () => readAppUiStateCache(),
  writeCachedAppUiState: ({ snapshot } = {}) => writeAppUiStateCache(snapshot),
  readCachedComposerDraft: ({ sessionId } = {}) =>
    ipcRenderer.invoke("butler:composer-draft-read", { sessionId }),
  writeCachedComposerDraft: ({ snapshot } = {}) =>
    ipcRenderer.invoke("butler:composer-draft-write", { snapshot }),
  subscribeLiveEvents,
  listTurns: ({ chatId = "general", cursor = 0 } = {}) => {
    const params = new URLSearchParams({
      chat_id: chatId,
      cursor: String(Number.isFinite(Number(cursor)) ? Number(cursor) : 0),
    });
    return requestJson(`/turns?${params.toString()}`);
  },
  uploadMessageFile: ({ name, mimeType, bytes, sessionId }) => {
    const form = new FormData();
    const fileBytes = bytes instanceof ArrayBuffer
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : new TextEncoder().encode(String(bytes ?? "")).buffer;
    form.set("file", new Blob([fileBytes], { type: mimeType || "application/octet-stream" }), name || "attachment");
    if (sessionId) form.set("session_id", sessionId);
    return requestJson("/message-files", {
      method: "POST",
      body: form,
    });
  },
  sendMessage: ({ chatId, text, clientMessageId, model, reasoningEffort, accessMode, planMode, queuePolicy, attachments }) => requestJson("/messages", {
    method: "POST",
    body: JSON.stringify({
      chat_id: chatId,
      text,
      client_message_id: clientMessageId,
      model,
      reasoning_effort: reasoningEffort,
      access_mode: accessMode,
      plan_mode: planMode,
      queue_policy: queuePolicy,
      attachments,
    }),
  }),
  listSessionQueue: ({ sessionId = "general" } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/session-queue?${params.toString()}`);
  },
  getAuthorityRequests: ({ sessionId } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(`/authority-requests?${params.toString()}`);
  },
  allowAuthorityRequest: ({ sessionId, requestRef } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(
      `/authority-requests/${encodeURIComponent(requestRef ?? "")}/allow?${params.toString()}`,
      { method: "POST" },
    );
  },
  denyAuthorityRequest: ({ sessionId, requestRef } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(
      `/authority-requests/${encodeURIComponent(requestRef ?? "")}/deny?${params.toString()}`,
      { method: "POST" },
    );
  },
  modifyAuthorityRequest: ({ alternative, sessionId, requestRef } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(
      `/authority-requests/${encodeURIComponent(requestRef ?? "")}/modify?${params.toString()}`,
      {
        method: "POST",
        body: JSON.stringify({ alternative }),
      },
    );
  },
  queueMessage: ({ chatId, text, model, reasoningEffort, accessMode, planMode, attachments }) => requestJson("/session-queue", {
    method: "POST",
    body: JSON.stringify({
      chat_id: chatId,
      text,
      model,
      reasoning_effort: reasoningEffort,
      access_mode: accessMode,
      plan_mode: planMode,
      attachments,
    }),
  }),
  updateQueuedMessage: ({ queuedMessageId, text, model, reasoningEffort, accessMode, planMode, attachments }) =>
    requestJson(`/session-queue/${encodeURIComponent(queuedMessageId ?? "")}`, {
      method: "PATCH",
      body: JSON.stringify({
        text,
        model,
        reasoning_effort: reasoningEffort,
        access_mode: accessMode,
        plan_mode: planMode,
        attachments,
      }),
    }),
  deleteQueuedMessage: ({ queuedMessageId } = {}) => requestJson(`/session-queue/${encodeURIComponent(queuedMessageId ?? "")}`, {
    method: "DELETE",
  }),
  retryTurn: ({ turnId }) => requestJson(`/turns/${encodeURIComponent(turnId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  retryTurnWithCurrentControls: ({ turnId }) => requestJson(`/turns/${encodeURIComponent(turnId)}/retry-current`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  cancelTurn: ({ turnId }) => requestJson(`/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  cancelSteward: ({ relationId, parentSessionId }) => requestJson(
    `/steward-relations/${encodeURIComponent(relationId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ parent_session_id: parentSessionId }),
    },
  ),
  resumeSteward: ({ relationId, parentSessionId }) => requestJson(
    `/steward-relations/${encodeURIComponent(relationId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ parent_session_id: parentSessionId }),
    },
  ),
  getOperationOutput: ({ turnId, requestId, resultId, offset = 0 }) => {
    const params = new URLSearchParams({
      result_id: resultId,
      offset: String(offset),
    });
    return requestJson(
      `/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(requestId)}` +
        `/output?${params.toString()}`,
    );
  },
  getSettings: () => requestJson("/settings"),
  showDesktopNotification: ({ kind, title, body, sessionId } = {}) =>
    ipcRenderer.invoke("butler:show-desktop-notification", {
      kind,
      title,
      body,
      sessionId,
    }),
  getNativeNotificationStatus: () =>
    ipcRenderer.invoke("butler:get-native-notification-status"),
  testDesktopNotification: () =>
    ipcRenderer.invoke("butler:test-desktop-notification"),
  openNativeNotificationSettings: () =>
    ipcRenderer.invoke("butler:open-native-notification-settings"),
  setNativeShellPreferences: ({ trayEnabled } = {}) =>
    ipcRenderer.invoke("butler:set-native-shell-preferences", {
      trayEnabled,
    }),
  onNativeNavigation: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, request) => handler(request);
    ipcRenderer.on("butler:native-navigation", listener);
    return () => ipcRenderer.removeListener("butler:native-navigation", listener);
  },
  listMcpServers: () => requestJson("/mcp-servers"),
  listMcpCapabilities: () => requestJson("/mcp-capabilities"),
  listSkills: () => requestJson("/skills"),
  importSkill: ({ name, bytes, projectId } = {}) => {
    const form = new FormData();
    const fileBytes = bytes instanceof ArrayBuffer
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : new TextEncoder().encode(String(bytes ?? "")).buffer;
    form.set("file", new Blob([fileBytes], { type: "application/zip" }), name || "skill.zip");
    if (projectId) form.set("project_id", projectId);
    return requestJson("/skills/import", {
      method: "POST",
      body: form,
    });
  },
  createMcpServer: (request) => requestJson("/mcp-servers", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  updateMcpServer: ({ serverId, request } = {}) => requestJson(`/mcp-servers/${encodeURIComponent(serverId ?? "")}`, {
    method: "PATCH",
    body: JSON.stringify(request ?? {}),
  }),
  deleteMcpServer: ({ serverId } = {}) => requestJson(`/mcp-servers/${encodeURIComponent(serverId ?? "")}`, {
    method: "DELETE",
  }),
  probeMcpServer: ({ serverId } = {}) => requestJson(`/mcp-servers/${encodeURIComponent(serverId ?? "")}/probe`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  setNativeAppearanceTheme: ({ theme } = {}) => ipcRenderer.invoke("butler:set-native-appearance-theme", { theme }),
  getPersonalization: () => requestJson("/personalization"),
  getProfileImportPrompt: ({ locale } = {}) => {
    const params = new URLSearchParams();
    if (locale) params.set("locale", locale);
    const query = params.toString();
    return requestJson(query ? `/personalization/profile-import-prompt?${query}` : "/personalization/profile-import-prompt");
  },
  updatePersonalization: (request) => requestJson("/personalization", {
    method: "PATCH",
    body: JSON.stringify(request ?? {}),
  }),
  importPersonalizationProfile: (request) => requestJson("/personalization/profile-import", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  getModelCatalog: () => requestJson("/model-catalog"),
  upsertProviderCredential: (request) => requestJson("/model-catalog/provider-credentials", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  registerHostedModel: (request) => requestJson("/model-catalog/registered-models", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  startOpenAIOAuthLogin: () =>
    ipcRenderer.invoke("butler:start-openai-oauth-login"),
  restartOpenAIOAuthLogin: () =>
    ipcRenderer.invoke("butler:restart-openai-oauth-login"),
  getOpenAIOAuthLoginStatus: () =>
    ipcRenderer.invoke("butler:get-openai-oauth-login-status"),
  submitOpenAIOAuthCallback: (request = {}) =>
    ipcRenderer.invoke("butler:submit-openai-oauth-callback", request ?? {}),
  deleteHostedModel: ({ modelRef } = {}) => requestJson(`/model-catalog/registered-models/${encodeURIComponent(modelRef ?? "")}`, {
    method: "DELETE",
  }),
  discoverLocalModels: (request) => requestJson("/model-catalog/local/discover", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  registerLocalModel: (request) => requestJson("/model-catalog/local-models", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  updateLocalModel: ({ modelRef, request } = {}) => requestJson(`/model-catalog/local-models/${encodeURIComponent(modelRef ?? "")}`, {
    method: "PATCH",
    body: JSON.stringify(request ?? {}),
  }),
  deleteLocalModel: ({ modelRef } = {}) => requestJson(`/model-catalog/local-models/${encodeURIComponent(modelRef ?? "")}`, {
    method: "DELETE",
  }),
  updateSettings: (settings) => requestJson("/settings", {
    method: "PATCH",
    body: JSON.stringify(settings ?? {}),
  }),
  listArchives: ({ limit, offset } = {}) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const query = params.toString();
    return requestJson(query ? `/archives?${query}` : "/archives");
  },
  listSystemEvents: ({ limit, offset } = {}) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const query = params.toString();
    return requestJson(query ? `/system-events?${query}` : "/system-events");
  },
  listDeveloperLogs: ({ limit, offset, sessionId, turnId, kind, query: search } = {}) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    if (sessionId) params.set("session_id", sessionId);
    if (turnId) params.set("turn_id", turnId);
    if (kind) params.set("kind", kind);
    if (search) params.set("query", search);
    const query = params.toString();
    return requestJson(query ? `/developer-logs?${query}` : "/developer-logs");
  },
  getUsageMonitor: ({ sessionId, sinceHours } = {}) => {
    const params = new URLSearchParams();
    if (sessionId) params.set("session_id", sessionId);
    if (sinceHours !== undefined) params.set("since_hours", String(sinceHours));
    const query = params.toString();
    return requestJson(query ? `/usage-monitor?${query}` : "/usage-monitor");
  },
  searchCommandPalette: ({ query = "" } = {}) => {
    const params = new URLSearchParams({ query });
    return requestJson(`/command-palette?${params.toString()}`);
  },
  getSessionSummary: ({ sessionId }) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/session-summary?${params.toString()}`);
  },
  getSessionView: ({ sessionId, cursorToken, beforeCursorToken, limit } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId });
    if (typeof cursorToken === "string" && cursorToken) {
      params.set("cursor_token", cursorToken);
    }
    if (typeof beforeCursorToken === "string" && beforeCursorToken) {
      params.set("before_cursor_token", beforeCursorToken);
    }
    if (limit !== undefined && Number.isFinite(Number(limit))) {
      params.set("limit", String(Math.max(1, Math.floor(Number(limit)))));
    }
    return requestBridgeResult(`/session-view?${params.toString()}`);
  },
  saveMessageFile: ({ fileId, suggestedName } = {}) =>
    ipcRenderer.invoke("butler:save-message-file", { fileId, suggestedName }),
  getContextDetails: ({ sessionId }) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/context-details?${params.toString()}`);
  },
  listArtifacts: ({ sessionId }) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/artifacts?${params.toString()}`);
  },
  exportTranscript: ({ sessionId }) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/transcript-export?${params.toString()}`);
  },
  listAutomations: ({ targetSessionId } = {}) => {
    const params = new URLSearchParams();
    if (targetSessionId) params.set("target_session_id", targetSessionId);
    const query = params.toString();
    return requestJson(query ? `/automations?${query}` : "/automations");
  },
  getAutomation: ({ automationId }) => requestJson(`/automations/${encodeURIComponent(automationId)}`),
  createAutomation: ({ title, promptBody, targetSessionId, intervalSeconds }) => requestJson("/automations", {
    method: "POST",
    body: JSON.stringify({
      title,
      prompt_body: promptBody,
      target_session_id: targetSessionId,
      interval_seconds: intervalSeconds,
    }),
  }),
  updateAutomation: ({ automationId, title, promptBody, targetSessionId, intervalSeconds, state }) =>
    requestJson(`/automations/${encodeURIComponent(automationId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        prompt_body: promptBody,
        target_session_id: targetSessionId,
        interval_seconds: intervalSeconds,
        state,
      }),
    }),
  deleteAutomation: ({ automationId }) => requestJson(`/automations/${encodeURIComponent(automationId)}`, {
    method: "DELETE",
  }),
  runAutomation: ({ automationId }) => requestJson(`/automations/${encodeURIComponent(automationId)}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  pauseAutomation: ({ automationId }) => requestJson(`/automations/${encodeURIComponent(automationId)}/pause`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  resumeAutomation: ({ automationId }) => requestJson(`/automations/${encodeURIComponent(automationId)}/resume`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  listAutomationRuns: ({ automationId }) => requestJson(`/automations/${encodeURIComponent(automationId)}/runs`),
  dispatchDueAutomations: () => requestJson("/automations/dispatch-due", {
    method: "POST",
    body: JSON.stringify({}),
  }),
  listWorkerActivity: ({ sessionId, includeHistory = false, limit, offset, cursor } = {}) => {
    if (sessionId) {
      const suffix = includeHistory ? "/history" : "";
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      if (cursor) params.set("cursor", String(cursor));
      const query = params.toString();
      return requestJson(`/sessions/${encodeURIComponent(sessionId)}/worker-activity${suffix}${query ? `?${query}` : ""}`);
    }
    const params = new URLSearchParams({ include_history: includeHistory ? "true" : "false" });
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    if (cursor) params.set("cursor", String(cursor));
    return requestJson(`/worker-activity?${params.toString()}`);
  },
  getWorkerActivity: ({ workerId }) => requestJson(`/worker-activity/${encodeURIComponent(workerId)}`),
  controlWorkerActivity: ({ workerId, action }) => requestJson(`/worker-activity/${encodeURIComponent(workerId)}/control`, {
    method: "POST",
    body: JSON.stringify({ action }),
  }),
  replayEvents: ({ cursor = 0, limit } = {}) => {
    const params = new URLSearchParams({
      cursor: String(Number.isFinite(Number(cursor)) ? Number(cursor) : 0),
    });
    if (limit !== undefined && Number.isFinite(Number(limit))) {
      params.set("limit", String(Math.max(1, Math.floor(Number(limit)))));
    }
    return requestJson(`/events?${params.toString()}`);
  },
  liveEventsUrl: ({ cursor = 0 } = {}) => {
    const params = new URLSearchParams({
      cursor: String(Number.isFinite(Number(cursor)) ? Number(cursor) : 0),
    });
    return new URL(`/events/live?${params.toString()}`, serverUrl).toString();
  },
});

contextBridge.exposeInMainWorld("butlerApp", butlerApp);

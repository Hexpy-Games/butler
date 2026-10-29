const { contextBridge, ipcRenderer } = require("electron");
ipcRenderer.on("butler:text-size", (_event, factor) => {
  if (typeof factor === "number" && Number.isFinite(factor) && factor > 0) document.documentElement.style.setProperty("--ui-scale", String(factor));
});

// Capture links before nested message menus; non-web schemes keep their handlers.
for (const type of ["click", "contextmenu"]) globalThis.window?.addEventListener(type, event => {
  const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
  const value = link?.href ?? (type === "contextmenu" ? event.composedPath()
    .find(node => node instanceof HTMLElement && node.hasAttribute("data-butler-link"))?.getAttribute("data-butler-link") : null);
  if (!value || !/^https?:/iu.test(value)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  // Links marked for the user's own browser (account pages that need existing sessions) skip the in-app tab.
  const op = type === "click" ? (link?.closest("[data-butler-link-target='external']") ? "external" : "open") : "menu";
  ipcRenderer.send("butler-app:link", op, value, { x: event.clientX, y: event.clientY });
}, true);

const port = Number(process.env.BUTLER_APP_SERVER_PORT ?? "18765");
let cachedServerUrl = normalizeLocalServerUrl(
  process.env.BUTLER_APP_SERVER_URL ??
    `http://127.0.0.1:${Number.isFinite(port) ? port : 18765}`,
);
const messageCacheSchema = "butler.message-cache.v1";
const messageCachePrefix = "butler:message-cache:v1:";
const appUiStateSchema = "butler.app-ui-state.v1";
const appUiStateKey = "butler:app-ui-state:v1";
const powerStateChannel = "butler:power-state";
const powerStateSubscribers = new Set();
let latestPowerState = null;
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

function normalizePowerState(value) {
  if (!value || typeof value !== "object" ||
      typeof value.onBattery !== "boolean" || typeof value.constrained !== "boolean") return null;
  return { onBattery: value.onBattery, constrained: value.constrained };
}

ipcRenderer.on(powerStateChannel, (_event, value) => {
  const state = normalizePowerState(value);
  if (!state || (latestPowerState && latestPowerState.onBattery === state.onBattery &&
      latestPowerState.constrained === state.constrained)) return;
  latestPowerState = state;
  for (const handler of powerStateSubscribers) handler(state);
});

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
    ...(code === "tag_exists" && error?.existing ? { existing: error.existing } : {}),
    ...(Number.isSafeInteger(error?.current?.revision) ? { current: { revision: error.current.revision } } : {}),
    code,
    ...(code === "hook_blocked" && typeof error?.message === "string" ? { hook_reason: error.message.slice(0, 16384) } : {}),
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

/** Settings -> Security calls: main sends them with its own credentials. */
async function requestSecurity(route, body) {
  try {
    return await ipcRenderer.invoke("butler:security-request", body === undefined ? { route } : { route, body });
  } catch (error) {
    return { ok: false, error: bridgeErrorEnvelope(error) };
  }
}

async function requestBridgeResult(path, options = {}) {
  try {
    return { ok: true, data: await requestJson(path, options) };
  } catch (error) {
    return { ok: false, error: bridgeErrorEnvelope(error) };
  }
}

const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/u;

/** A user action's W3C trace context, forwarded to the local agent only when well formed. */
function traceHeaders(traceparent) {
  return typeof traceparent === "string" && TRACEPARENT.test(traceparent) ? { traceparent } : {};
}

function wallpaperPath(id, suffix = "") {
  return `/wallpapers/${encodeURIComponent(String(id ?? ""))}${suffix}`;
}

/** A wallpaper image's bytes (or its thumbnail) with the local bearer token, as a bridge result envelope. */
async function readWallpaperImage({ id, variant } = {}) {
  try {
    await ensureLocalServer();
    const serverUrl = await currentServerUrl();
    const authHeaders = await localAuthHeaders();
    const path = wallpaperPath(id, variant === "thumbnail" ? "/thumbnail" : "");
    const response = await fetch(new URL(path, serverUrl), { headers: authHeaders });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = new Error("Wallpaper image request failed.");
      error.code = body?.error?.code ?? "request_failed";
      error.status = response.status;
      throw error;
    }
    const mimeType = response.headers.get("content-type") ?? "";
    return { ok: true, data: { bytes: await response.arrayBuffer(), mimeType } };
  } catch (error) {
    return { ok: false, error: bridgeErrorEnvelope(error) };
  }
}

function wallpaperModulePath(id, suffix) {
  return `/wallpaper-modules/${encodeURIComponent(String(id ?? ""))}/${suffix}`;
}

/** A user wallpaper module file (`shader`, `overlay` or `image`) with the local bearer token; throws the gateway's error code. */
async function fetchWallpaperModuleFile(id, suffix) {
  await ensureLocalServer();
  const serverUrl = await currentServerUrl();
  const authHeaders = await localAuthHeaders();
  const response = await fetch(new URL(wallpaperModulePath(id, suffix), serverUrl), { headers: authHeaders });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error("Wallpaper module request failed.");
    error.code = body?.error?.code ?? "request_failed";
    error.status = response.status;
    throw error;
  }
  return response;
}

/** A user wallpaper module's text file (shader.frag, overlay.frag) and its files' revision (the ETag), as a bridge result envelope. */
async function readWallpaperModuleText(id, suffix) {
  try {
    const response = await fetchWallpaperModuleFile(id, suffix);
    return { ok: true, data: { text: await response.text(), revision: response.headers.get("etag") ?? undefined } };
  } catch (error) {
    return { ok: false, error: bridgeErrorEnvelope(error) };
  }
}

const readWallpaperModuleShader = ({ id } = {}) => readWallpaperModuleText(id, "shader");
const readWallpaperModuleOverlay = ({ id } = {}) => readWallpaperModuleText(id, "overlay");

/** A user wallpaper module's default image bytes (its manifest `defaultImage`), as a bridge result envelope. */
async function readWallpaperModuleImage({ id } = {}) {
  try {
    const response = await fetchWallpaperModuleFile(id, "image");
    const mimeType = response.headers.get("content-type") ?? "";
    return { ok: true, data: { bytes: await response.arrayBuffer(), mimeType, revision: response.headers.get("etag") ?? undefined } };
  } catch (error) {
    return { ok: false, error: bridgeErrorEnvelope(error) };
  }
}

function bridgeBytes(bytes) {
  return bytes instanceof ArrayBuffer
    ? bytes
    : ArrayBuffer.isView(bytes)
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : new ArrayBuffer(0);
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

function recordWorkAction(path, options) {
  const traceparent = options.headers?.traceparent;
  const action = path === "/messages" || path === "/session-queue" || /^\/session-queue\/[^/]+\/send-now$/u.test(path) ? "send"
    : /\/turns\/[^/]+\/cancel$/u.test(path) ? "stop"
    : /\/turns\/[^/]+\/retry(?:-current)?$/u.test(path) ? "retry"
    : /\/sessions\/[^/]+\/controls$/u.test(path) && options.method === "PATCH" ? "model_pick" : null;
  if (!action) return;
  const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
  const turn_id = path.match(/^\/turns\/([^/]+)/u)?.[1];
  ipcRenderer.send("butler:app-log", { level: "INFO", category: "app.ui", event: `ui.${action}`,
    ...(traceparent ? { traceparent } : {}), ...(body.chat_id ? { chat_id: body.chat_id } : {}),
    ...(turn_id ? { turn_id: decodeURIComponent(turn_id) } : {}), attrs: {} });
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
    if (error.code === "tag_exists" && body?.error?.existing) error.existing = body.error.existing;
    if (Number.isSafeInteger(body?.error?.current?.revision)) error.current = { revision: body.error.current.revision };
    throw error;
  }
  if (!body || body.protocol_version !== "butler.app.v1") {
    const error = new Error("App server returned an invalid protocol envelope.");
    error.code = "invalid_protocol";
    error.status = response.status;
    throw error;
  }
  recordWorkAction(path, options);
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

const connectionCodeRotatedEvent = "security.connection_code_rotated";

/** Main re-reads the data-folder token file after the connection code rotates. */
async function reloadLocalAuth() {
  try {
    await ipcRenderer.invoke("butler:reload-local-auth");
  } catch {
    // The next request retries with whatever token main holds.
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

function drainSseRecords(buffer, onEvent, onHeartbeat) {
  let remaining = buffer;
  while (true) {
    const match = /(?:\r\n\r\n|\n\n|\r\r)/u.exec(remaining);
    if (!match) return remaining;
    const record = remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);
    if (!record.trim()) continue;
    if (/^event:\s*heartbeat\s*$/mu.test(record) || /^: heartbeat\s*$/mu.test(record)) {
      onHeartbeat?.();
      continue;
    }
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
  const forwardEvent = typeof handlers?.onEvent === "function"
    ? handlers.onEvent
    : () => {};
  const onEvent = (event) => {
    if (event?.type === connectionCodeRotatedEvent) void reloadLocalAuth();
    forwardEvent(event);
  };
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
        // A code rotated while the stream was down: reconnect with the new token.
        if (response.status === 401) await reloadLocalAuth();
        const error = new Error(`Live event stream failed with status ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      if (!response.body) {
        throw new Error("Live event stream response did not include a body.");
      }
      reader = response.body.getReader();
      if (closed) { await reader.cancel(); return; }
      handlers.onOpen?.();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = drainSseRecords(
          buffer + decoder.decode(value, { stream: true }),
          onEvent,
          handlers.onHeartbeat,
        );
      }
      buffer = drainSseRecords(buffer + decoder.decode(), onEvent, handlers.onHeartbeat);
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

/** A redacted log body (GET /logs/bodies/{ref}) as text. */
async function readLogBody(reference) {
  await ensureLocalServer();
  const path = `/logs/bodies/${encodeURIComponent(String(reference ?? ""))}`;
  const response = await fetch(new URL(path, await currentServerUrl()), { headers: await localAuthHeaders() });
  if (!response.ok) {
    const error = new Error(`Log body request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return await response.text();
}

/** GET /logs/live: `log` events carry one record; `lagged` counts are skipped. */
function subscribeLogs(handlers = {}) {
  const abortController = new AbortController();
  let closed = false;
  const deliver = (value) => {
    if (value && typeof value === "object") handlers.onRecord?.(value);
  };
  void (async () => {
    try {
      await ensureLocalServer();
      const response = await fetch(new URL("/logs/live", await currentServerUrl()), {
        headers: { accept: "text/event-stream", ...(await localAuthHeaders()) },
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Log stream failed with status ${response.status}.`);
      const reader = response.body.getReader();
      handlers.onOpen?.();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = drainSseRecords(buffer + decoder.decode(value, { stream: true }), deliver);
      }
      if (!closed) throw new Error("Log stream ended.");
    } catch (error) {
      if (!closed && error?.name !== "AbortError") handlers.onError?.();
    }
  })();
  return () => {
    closed = true;
    abortController.abort();
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
  log: row => ipcRenderer.send("butler:app-log", row),
  documents: ({ path, method = "GET", body } = {}) => {
    method = String(method).toUpperCase();
    const url = new URL(String(path ?? ""), "http://local");
    const read = method === "GET" && /^\/documents\/[^/]+(?:\/revisions(?:\/[1-9][0-9]*)?|\/diff)?$/u.test(url.pathname);
    const write = (method === "POST" && (url.pathname === "/documents" || /^\/documents\/[^/]+\/(restore|seen|blocks\/[0-9]+)$/u.test(url.pathname)))
      || (method === "PUT" && /^\/documents\/[^/]+$/u.test(url.pathname));
    if (!read && !write) throw new Error("Unsupported document route.");
    return requestBridgeResult(url.pathname + url.search, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  },
  saveLibraryDocument: (body) => requestBridgeResult("/library/documents", { method: "POST", body: JSON.stringify(body) }),
  saveLibraryBlock: (body) => requestBridgeResult("/library/blocks", { method: "POST", body: JSON.stringify(body) }),
  organizeLibrary: ({ path, method, body }) => {
    const route = new URL(path, "http://butler.invalid");
    const allowed = /^\/library\/(groups|tags|facets|items)(\/|$)/.test(route.pathname);
    if (!allowed || !["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new Error("Invalid Library request.");
    return requestJson(route.pathname + route.search, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  },
  history: ({ path, method = "GET", body }) => {
    if (!/^\/browser-history(?:\/(?:search|suggestions|delete|delete-url|clear))?(?:\?|$)/u.test(path)) throw new Error("invalid_history_route");
    return requestJson(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  },
  listLibrary: (input = {}) => requestJson(`/library?${new URLSearchParams(input)}`),
  saveLibrary: (item) => requestJson("/library", { method: "POST", body: JSON.stringify(item) }),
  deleteLibrary: (id) => requestJson(`/library/${encodeURIComponent(id)}`, { method: "DELETE" }),
  librarySnapshot: (id) => requestJson(`/library/${encodeURIComponent(id)}/snapshot`),
  imageModelSettings: ({ method = "GET", body } = {}) => {
    if (!["GET", "PUT"].includes(method)) throw new Error("invalid_image_settings_method");
    return requestBridgeResult("/settings/image-model", { method, ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
  },
  imageAssetInfo: ({ path }) => {
    if (!/^\/message-assets\/img_[a-z0-9]{10}(?:[a-z0-9]{2})?\/(meta|versions)$/u.test(path)) throw new Error("invalid_image_asset_route");
    return requestBridgeResult(path);
  },
  uploadImageMask: ({ session, image, bytes }) => {
    if (typeof session !== "string" || !/^img_[a-z0-9]{10}(?:[a-z0-9]{2})?$/u.test(image)
      || !(bytes instanceof Uint8Array) || bytes.length > 50 * 1024 * 1024) throw new Error("invalid_image_mask");
    return requestBridgeResult(`/message-assets/masks?${new URLSearchParams({ session, for: image })}`, {
      method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from(bytes),
    });
  },
  saveImageAsset: ({ id, suggestedName }) => ipcRenderer.invoke("butler:save-image-asset", { id, suggestedName }),
  protocolVersion: "butler.app.v1",
  signalStartupReady: () => ipcRenderer.send("butler:renderer-ready"),
  setupWindowReady: () => ipcRenderer.invoke("butler:setup-window-ready"),
  get serverUrl() {
    return cachedServerUrl;
  },
  platform: process.platform,
  startupIssue: process.argv.includes("--butler-legacy-data") ? "legacy-data" : null,
  recoverLegacyData: (action) => ipcRenderer.invoke("butler:legacy-data-recovery", action),
  // Settings > General > reset everything. The phrase is checked in the renderer;
  // main sends the request with the admin credential, then relaunches.
  requestFullReset: ({ operationId } = {}) => ipcRenderer.invoke("butler:full-reset-request", { operationId }),
  relaunchAfterFullReset: () => ipcRenderer.invoke("butler:full-reset-relaunch"),
  fullResetFailed: process.argv.includes("--butler-full-reset-failed"),
  recordUiCrash: (input) => ipcRenderer.invoke("butler:ui-crash", input),
  recordWallpaperState: (line) => ipcRenderer.send("butler:wallpaper-state", line),
  readUiCrashLog: () => ipcRenderer.invoke("butler:ui-crash-log"),
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
  // #230 first-run routes served by the agent (#279). Envelopes keep the
  // public error code (invalid_key, no_access, network, ...) across contextBridge.
  getSetupReadiness: () => requestBridgeResult("/setup/readiness"),
  retrySetupReadiness: (input) => requestBridgeResult("/setup/readiness/retry", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }),
  chooseMemoryModel: (input) => requestBridgeResult("/setup/memory-model", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }),
  getChatGptAccount: () => requestBridgeResult("/setup/chatgpt-account"),
  acknowledgeChatGptNotice: (request) => requestBridgeResult("/setup/chatgpt-account/notice", {
    method: "POST", body: JSON.stringify(request ?? {}),
  }),
  signOutChatGpt: () => requestBridgeResult("/setup/chatgpt-account/sign-out", {
    method: "POST", body: "{}",
  }),
  startSetupOAuth: (request) => requestBridgeResult("/setup/oauth/start", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  getSetupOAuthFlow: ({ flowId } = {}) =>
    requestBridgeResult(`/setup/oauth/${encodeURIComponent(flowId ?? "")}`),
  getLocalModelServers: () => requestJson("/setup/local-model-servers"),
  verifySetupCredential: (request) => requestBridgeResult("/setup/credentials/verify", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  saveCredential: (request) => requestBridgeResult("/credentials", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  // #217 saved keys, with the same envelopes (invalid_key, credential_in_use, ...).
  listCredentials: () => requestBridgeResult("/credentials"),
  replaceCredential: ({ name, request } = {}) =>
    requestBridgeResult(`/credentials/${encodeURIComponent(name ?? "")}`, {
      method: "PATCH",
      body: JSON.stringify(request ?? {}),
    }),
  deleteCredential: ({ name, force } = {}) =>
    requestBridgeResult(
      `/credentials/${encodeURIComponent(name ?? "")}${force === true ? "?force=true" : ""}`,
      { method: "DELETE" },
    ),
  cancelSetupOAuth: ({ flowId } = {}) =>
    requestBridgeResult(`/setup/oauth/${encodeURIComponent(flowId ?? "")}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
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
  cancelUpdate: () => requestJson("/updates/cancel", { method: "POST" }),
  setUpdateProgress: (value) => ipcRenderer.invoke("butler:update-progress", value),
  getAppUpdateState: () => ipcRenderer.invoke("butler:app-update-state"),
  chooseAppUpdate: (input) => ipcRenderer.invoke("butler:app-update-choice", input),
  onAppUpdateState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("butler:app-update-state", listener);
    return () => ipcRenderer.removeListener("butler:app-update-state", listener);
  },
  onPowerState: (handler) => {
    if (typeof handler !== "function") return () => {};
    powerStateSubscribers.add(handler);
    if (latestPowerState) handler(latestPowerState);
    return () => { powerStateSubscribers.delete(handler); };
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
      const activation = await ipcRenderer.invoke("butler:open-update-artifact", {
        artifactPath: result.artifact_path,
      });
      return { ...result, app_restart_status: activation.update.status };
    }
    return result;
  },
  memoryRequest: ({ path, method = "GET", body } = {}) => {
    const existing = /^\/memory\/(inventory(?:\/check)?|instructions(?:\/[A-Za-z0-9]+)?|projects\/[A-Za-z0-9_-]+|cleanup(?:\/[a-f0-9-]+)?)$/.test(path);
    const reset = (method === "POST" && /^\/memory\/reset\/(chat-memory|profile|projects\/[A-Za-z0-9_-]+)$/.test(path)) ||
      (method === "GET" && /^\/memory\/reset\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path));
    const patterns = (method === "GET" && path === "/memory/patterns") ||
      (method === "DELETE" && /^\/memory\/patterns\/[A-Za-z0-9_-]+$/.test(path));
    const proposals = (method === "GET" && path === "/memory/pattern-proposals") ||
      (method === "POST" && /^\/memory\/pattern-proposals\/[A-Za-z0-9_-]+$/.test(path));
    if (proposals) return requestBridgeResult(path, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    const consolidation = path === "/memory/consolidation" && ["GET", "POST"].includes(method);
    if (consolidation) return requestBridgeResult(path, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    if (!existing && !reset && !patterns) throw new Error("Invalid memory path");
    return requestJson(path, { method, ...(body && method !== "GET" && method !== "HEAD" ? { body: JSON.stringify(body) } : {}) });
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
  mutateSpace: ({ resource, body }) => {
    if (!["groups", "moves", "group-sessions", "undo", "pins", "relocations", "branches", "branch-source"].includes(resource)) throw new Error("Invalid space operation");
    return requestBridgeResult(`/space/${resource}`, { method: "POST", body: JSON.stringify(body) });
  },
  changeSpaceGroup: ({ groupId, method, body }) => {
    if (method !== "PATCH" && method !== "DELETE") throw new Error("Invalid group operation");
    return requestJson(`/space/groups/${encodeURIComponent(groupId)}`, { method, body: JSON.stringify(body) });
  },
  getProjectDashboard: ({ projectId }) => requestJson(`/projects/${encodeURIComponent(projectId)}/dashboard`),
  getProjectDashboardResource: ({ projectId, resource, query = "" }) => {
    if (!["records", "materials", "source", "history", "artifacts", "statistics"].includes(resource)) throw new Error("Invalid dashboard resource");
    const params = new URLSearchParams(query);
    return requestJson(`/projects/${encodeURIComponent(projectId)}/dashboard/${resource}?${params.toString()}`);
  },
  updateProjectDashboardResource: ({ projectId, resource, body }) => {
    if (!["preferences", "briefing", "attachment"].includes(resource)) throw new Error("Invalid dashboard operation");
    return requestJson(`/projects/${encodeURIComponent(projectId)}/dashboard/${resource}`, {
      method: resource === "preferences" ? "PATCH" : "POST", body: JSON.stringify(body),
    });
  },
  selectProjectFolder: () => ipcRenderer.invoke("butler:select-project-folder"),
  listSessions: ({ kind, projectId } = {}) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (projectId) params.set("project_id", projectId);
    const query = params.toString();
    return requestJson(query ? `/sessions?${query}` : "/sessions");
  },
  createSession: ({ kind, title, initialMessage, projectId, sessionHint, idempotencyKey, workspaceMode }) => requestJson("/sessions", {
    method: "POST",
    body: JSON.stringify({
      kind,
      title,
      initial_message: initialMessage,
      workspace_mode: workspaceMode,
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
  clearGeneral: ({ title }) => requestJson("/sessions/general/clear", {
    method: "POST",
    body: JSON.stringify({ title }),
  }),
  archiveSession: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  sessionComposing: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/composing`, {
    method: "POST", body: JSON.stringify({}),
  }),
  decideReportPause: ({ automationId, decision }) => requestBridgeResult(`/automations/${encodeURIComponent(automationId)}/report-pause`, {
    method: "POST", body: JSON.stringify({ decision }),
  }),
  markSessionRead: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  deleteSessionPermanent: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}?permanent=true`, {
    method: "DELETE",
  }),
  getSessionControls: ({ sessionId }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/controls`),
  updateSessionControls: ({ sessionId, controls, traceparent }) => requestJson(`/sessions/${encodeURIComponent(sessionId)}/controls`, {
    method: "PATCH",
    headers: traceHeaders(traceparent),
    body: JSON.stringify(controls ?? {}),
  }),
  decideSessionPlan: ({ sessionId, planId, action, instruction } = {}) => requestJson(
    `/sessions/${encodeURIComponent(sessionId ?? "")}/plan-decisions/${encodeURIComponent(planId ?? "")}`,
    {
      method: "POST",
      body: JSON.stringify({ action, ...(instruction ? { instruction } : {}) }),
    },
  ),
  listProjectSessions: ({ projectId } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    const query = params.toString();
    return requestJson(query ? `/project-sessions?${query}` : "/project-sessions");
  },
  getWorkStatus: () => requestJson("/work-status"),
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
  uploadCanonFile: ({ projectId, name, mimeType, bytes }) => {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), name || "attachment");
    return requestBridgeResult(`/projects/${encodeURIComponent(projectId)}/canon/files`, { method: "POST", body: form });
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
  sendMessage: ({ chatId, text, contentParts, imageEdit, clientMessageId, model, reasoningEffort, accessMode, planMode, queuePolicy, attachments, traceparent }) => requestBridgeResult("/messages", {
    method: "POST",
    headers: traceHeaders(traceparent),
    body: JSON.stringify({
      chat_id: chatId,
      text,
      client_message_id: clientMessageId,
      content_parts: contentParts,
      image_edit: imageEdit,
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
  getSessionPendingAsks: ({ sessionId } = {}) => requestJson(`/sessions/${encodeURIComponent(sessionId ?? "")}/pending-asks`),
  getPendingAsks: ({ limit, before } = {}) => {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (before !== undefined) query.set("before", before);
    return requestJson(`/pending-asks${query.size ? `?${query}` : ""}`);
  },
  dismissPendingAsk: ({ sessionId, askId } = {}) => requestJson(
    `/sessions/${encodeURIComponent(sessionId ?? "")}/pending-asks/${encodeURIComponent(askId ?? "")}/dismiss`,
    { method: "POST" },
  ),
  getAuthorityPermissions: () => requestJson("/authority-permissions"),
  revokeAuthorityPermissions: ({ grants } = {}) => requestJson("/authority-permissions/revoke", {
    method: "POST", body: JSON.stringify({ grants }),
  }),
  getAuthorityRequests: ({ sessionId } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(`/authority-requests?${params.toString()}`);
  },
  allowAuthorityRequest: ({ sessionId, requestRef, scope = "once" } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(
      `/authority-requests/${encodeURIComponent(requestRef ?? "")}/allow?${params.toString()}`,
      { method: "POST", body: JSON.stringify({ scope }) },
    );
  },
  revokeConversationPermission: ({ sessionId, grantRef } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(`/authority-permissions/${encodeURIComponent(grantRef ?? "")}?${params.toString()}`, { method: "DELETE" });
  },
  denyAuthorityRequest: ({ sessionId, requestRef } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(
      `/authority-requests/${encodeURIComponent(requestRef ?? "")}/deny?${params.toString()}`,
      { method: "POST" },
    );
  },
  answerUserQuestions: ({ response, sessionId, requestRef } = {}) => {
    const params = new URLSearchParams({ session_id: sessionId ?? "general" });
    return requestJson(`/authority-requests/${encodeURIComponent(requestRef ?? "")}/answer?${params.toString()}`, {
      method: "POST", body: JSON.stringify(response),
    });
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
  queueMessage: ({ chatId, text, contentParts, imageEdit, model, reasoningEffort, accessMode, planMode, attachments, traceparent }) => requestBridgeResult("/session-queue", {
    method: "POST",
    headers: traceHeaders(traceparent),
    body: JSON.stringify({
      chat_id: chatId,
      text,
      content_parts: contentParts,
      image_edit: imageEdit,
      model,
      reasoning_effort: reasoningEffort,
      access_mode: accessMode,
      plan_mode: planMode,
      attachments,
    }),
  }),
  updateQueuedMessage: ({ queuedMessageId, text, contentParts, imageEdit, model, reasoningEffort, accessMode, planMode, attachments }) =>
    requestJson(`/session-queue/${encodeURIComponent(queuedMessageId ?? "")}`, {
      method: "PATCH",
      body: JSON.stringify({
        text,
        content_parts: contentParts,
        image_edit: imageEdit,
        model,
        reasoning_effort: reasoningEffort,
        access_mode: accessMode,
        plan_mode: planMode,
        attachments,
      }),
    }),
  sendQueuedMessageNow: ({ queuedMessageId, traceparent } = {}) => requestJson(`/session-queue/${encodeURIComponent(queuedMessageId ?? "")}/send-now`, {
    method: "POST",
    headers: traceHeaders(traceparent),
    body: JSON.stringify({}),
  }),
  deleteQueuedMessage: ({ queuedMessageId } = {}) => requestJson(`/session-queue/${encodeURIComponent(queuedMessageId ?? "")}`, {
    method: "DELETE",
  }),
  retryTurn: ({ turnId, traceparent }) => requestJson(`/turns/${encodeURIComponent(turnId)}/retry`, {
    method: "POST",
    headers: traceHeaders(traceparent),
    body: JSON.stringify({}),
  }),
  retryTurnWithCurrentControls: ({ turnId, traceparent }) => requestJson(`/turns/${encodeURIComponent(turnId)}/retry-current`, {
    method: "POST",
    headers: traceHeaders(traceparent),
    body: JSON.stringify({}),
  }),
  cancelTurn: ({ turnId, traceparent }) => requestJson(`/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: "POST",
    headers: traceHeaders(traceparent),
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
  getBrowserStills: ({ id, sessionId, wait }) => requestJson(
    `/browser-stills/${encodeURIComponent(id)}?${new URLSearchParams({ session_id: sessionId, wait: wait ? "1" : "0" })}`,
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
  getLoginSettings: () => ipcRenderer.invoke("butler:get-login-settings"),
  setLoginSettings: (input) => ipcRenderer.invoke("butler:set-login-settings", input),
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
  getAgentState: () => ipcRenderer.invoke("butler:agent-state"),
  startAgent: () => ipcRenderer.invoke("butler:agent-start"),
  onAgentState: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("butler:agent-state", listener);
    return () => ipcRenderer.removeListener("butler:agent-state", listener);
  },
  onNativeNavigation: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, request) => handler(request);
    ipcRenderer.on("butler:native-navigation", listener);
    return () => ipcRenderer.removeListener("butler:native-navigation", listener);
  },
  listWallpapers: () => requestBridgeResult("/wallpapers"),
  uploadWallpaper: ({ name, mimeType, bytes } = {}) => {
    const form = new FormData();
    const fileBytes = bytes instanceof ArrayBuffer
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : new ArrayBuffer(0);
    form.set("file", new Blob([fileBytes], { type: mimeType || "application/octet-stream" }), name || "wallpaper");
    return requestBridgeResult("/wallpapers", { method: "POST", body: form });
  },
  deleteWallpaper: ({ id } = {}) => requestBridgeResult(wallpaperPath(id), { method: "DELETE" }),
  readWallpaperImage,
  listWallpaperModules: () => requestBridgeResult("/wallpaper-modules"),
  readWallpaperModuleShader,
  readWallpaperModuleOverlay,
  readWallpaperModuleImage,
  importWallpaperModule: ({ name, bytes, replace } = {}) => {
    const form = new FormData();
    form.set("file", new Blob([bridgeBytes(bytes)], { type: "application/zip" }), name || "module.zip");
    return requestBridgeResult(`/wallpaper-modules/import${replace === true ? "?replace=1" : ""}`, { method: "POST", body: form });
  },
  deleteWallpaperModule: ({ id } = {}) => requestBridgeResult(`/wallpaper-modules/${encodeURIComponent(String(id ?? ""))}`, { method: "DELETE" }),
  reportWallpaperModuleStatus: ({ id, state, message, revision } = {}) => requestBridgeResult(wallpaperModulePath(id, "status"), {
    method: "POST",
    body: JSON.stringify({
      ...(state === "error" ? { state, message: String(message ?? "") } : { state: state === "checking" ? "checking" : "ok" }),
      ...(typeof revision === "string" && revision ? { revision } : {}),
    }),
  }),
  getHooks: () => requestSecurity("getHooks"),
  saveHooks: (body) => requestSecurity("saveHooks", body),
  getHookRuns: () => requestSecurity("getHookRuns"),
  testHook: (body) => requestSecurity("testHook", body),
  listMcpServers: () => requestBridgeResult("/mcp-servers"),
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
    return requestBridgeResult("/skills/import", {
      method: "POST",
      body: form,
    });
  },
  createMcpServer: (request) => requestBridgeResult("/mcp-servers", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  updateMcpServer: ({ serverId, request } = {}) => requestBridgeResult(`/mcp-servers/${encodeURIComponent(serverId ?? "")}`, {
    method: "PATCH",
    body: JSON.stringify(request ?? {}),
  }),
  deleteMcpServer: ({ serverId } = {}) => requestBridgeResult(`/mcp-servers/${encodeURIComponent(serverId ?? "")}`, {
    method: "DELETE",
  }),
  probeMcpServer: ({ serverId } = {}) => requestBridgeResult(`/mcp-servers/${encodeURIComponent(serverId ?? "")}/probe`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  initialTextSize: process.argv.find(arg => arg.startsWith("--butler-text-size="))?.split("=")[1] ?? "default",
  setTextSize: value => ipcRenderer.invoke("butler:set-text-size", value),
  onTextSizeShortcut: handler => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on("butler:text-size-shortcut", listener);
    return () => ipcRenderer.removeListener("butler:text-size-shortcut", listener);
  },
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
  deleteHostedModel: ({ modelRef } = {}) => requestJson(`/model-catalog/registered-models/${encodeURIComponent(modelRef ?? "")}`, {
    method: "DELETE",
  }),
  discoverLocalModels: (request) => requestBridgeResult("/model-catalog/local/discover", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  registerLocalModel: (request) => requestBridgeResult("/model-catalog/local-models", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  }),
  updateLocalModel: ({ modelRef, request } = {}) => requestBridgeResult(`/model-catalog/local-models/${encodeURIComponent(modelRef ?? "")}`, {
    method: "PATCH",
    body: JSON.stringify(request ?? {}),
  }),
  deleteLocalModel: ({ modelRef } = {}) => requestJson(`/model-catalog/local-models/${encodeURIComponent(modelRef ?? "")}`, {
    method: "DELETE",
  }),
  // Envelope, not a throw: the renderer needs the public error code
  // (e.g. settings_model_unavailable) to show localized, actionable copy.
  // A `security` change carries the admin credential, which only main holds.
  updateSettings: async (settings) => {
    const result = await (settings?.security !== undefined
    ? requestSecurity("updateSecuritySettings", settings)
    : requestBridgeResult("/settings", {
      method: "PATCH",
      body: JSON.stringify(settings ?? {}),
    }));
    if (result.ok !== false && (settings?.diagnostics_enabled !== undefined || settings?.developer_mode_enabled !== undefined)) await ipcRenderer.invoke("butler:app-log-change");
    return result;
  },
  // Envelopes keep the code and status of the gateway's local-only rule.
  listOauthCredentials: () => requestSecurity("listOauthCredentials"),
  removeOauthCredential: ({ id } = {}) => requestSecurity("removeOauthCredential", { id }),
  getSecurity: () => requestSecurity("getSecurity"),
  issuePairingCode: () => requestSecurity("issuePairingCode"),
  getPairingStatus: () => requestSecurity("getPairingStatus"),
  listPairedDevices: () => requestSecurity("listPairedDevices"),
  revokePairedDevice: ({ deviceId } = {}) => requestSecurity("revokePairedDevice", { deviceId }),
  revokeAllPairedDevices: () => requestSecurity("revokeAllPairedDevices"),
  // Sign-ins and browser import (host only). A password typed here goes to main,
  // then to the Agent's keychain store; no route ever answers one.
  listSignIns: () => requestSecurity("listSignIns"),
  addSignIn: (payload) => requestSecurity("addSignIn", { payload }),
  updateSignIn: ({ id, payload } = {}) => requestSecurity("updateSignIn", { id, payload }),
  deleteSignIn: ({ id } = {}) => requestSecurity("deleteSignIn", { id }),
  updateSignInSite: (payload) => requestSecurity("updateSignInSite", { payload }),
  listImportSources: () => requestSecurity("listImportSources"),
  previewImport: (payload) => requestSecurity("previewImport", { payload }),
  runImport: (payload) => requestSecurity("runImport", { payload }),
  startBrowserImport: (payload) => requestSecurity("startBrowserImport", { payload }),
  undoBrowserImport: (payload) => requestSecurity("undoBrowserImport", { payload }),
  pickBrowserImportFolder: (payload) => requestSecurity("pickBrowserImportFolder", { payload }),
  openBrowserImportDiskAccess: (payload) => requestSecurity("openBrowserImportDiskAccess", { payload }),
  beginBrowserPasswordExport: (payload) => requestSecurity("beginBrowserPasswordExport", { payload }),
  pollBrowserPasswordExport: (payload) => requestSecurity("pollBrowserPasswordExport", { payload }),
  chooseBrowserPasswordExport: (payload) => requestSecurity("chooseBrowserPasswordExport", { payload }),
  deleteBrowserPasswordExport: (payload) => requestSecurity("deleteBrowserPasswordExport", { payload }),
  cancelBrowserPasswordExport: (payload) => requestSecurity("cancelBrowserPasswordExport", { payload }),
  // Import from other AI tools (host only): instructions and MCP servers, never secrets.
  listAgentImportSources: () => requestSecurity("listAgentImportSources"),
  startAgentImport: (payload) => requestSecurity("startAgentImport", { payload }),
  undoAgentImport: (payload) => requestSecurity("undoAgentImport", { payload }),
  // Payment methods and autofill details (host only). Card and identity numbers
  // go to main, then to the Agent's keychain store; only a card reveal, after
  // the operating system verifies the user, answers a number.
  listVault: () => requestSecurity("listVault"),
  addCard: (payload) => requestSecurity("addCard", { payload }),
  addProfile: (payload) => requestSecurity("addProfile", { payload }),
  updateCard: ({ id, payload } = {}) => requestSecurity("updateCard", { id, payload }),
  updateProfile: ({ id, payload } = {}) => requestSecurity("updateProfile", { id, payload }),
  deleteCard: ({ id } = {}) => requestSecurity("deleteCard", { id }),
  deleteProfile: ({ id } = {}) => requestSecurity("deleteProfile", { id }),
  setCardSite: ({ id, payload } = {}) => requestSecurity("setCardSite", { id, payload }),
  setProfileSite: ({ id, payload } = {}) => requestSecurity("setProfileSite", { id, payload }),
  revealProfile: ({ id, payload } = {}) => requestSecurity("revealProfile", { id, payload }),
  revealCard: ({ id, payload } = {}) => requestSecurity("revealCard", { id, payload }),
  setPurchaseSite: (payload) => requestSecurity("setPurchaseSite", { payload }),
  // The file path is chosen in a native dialog and stays in main and the Agent.
  pickBrowserFolder: () => ipcRenderer.invoke("butler:pick-browser-folder"),
  pickImportFile: (kind) => ipcRenderer.invoke("butler:pick-import-file", kind === "bookmarks" ? "bookmarks" : "passwords"),
  // Main re-reads the token after a rotation.
  rotateConnectionCode: () => requestSecurity("rotateConnectionCode"),
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
  // Settings > Logs JSON routes (GET /logs, /logs/config, /logs/storage, /logs/trace; PUT config; DELETE).
  logs: ({ path, method = "GET", body } = {}) => {
    const url = new URL(String(path ?? ""), "http://local");
    const trace = url.pathname === "/logs/trace" || /^\/logs\/trace\/[0-9a-f]{32}$/u.test(url.pathname);
    if (!trace && !["/logs", "/logs/config", "/logs/storage"].includes(url.pathname)) {
      throw new Error("Unsupported log route.");
    }
    return requestJson(url.pathname + url.search, {
      method: String(method).toUpperCase(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async result => {
      if (String(method).toUpperCase() === "PUT") await ipcRenderer.invoke("butler:app-log-change");
      if (String(method).toUpperCase() === "DELETE") await ipcRenderer.invoke("butler:app-log-change", "clear");
      return result;
    });
  },
  readLogBody: ({ reference } = {}) => readLogBody(reference),
  subscribeLogs: (handlers = {}) => subscribeLogs(handlers),
  exportLogs: ({ since, includeBodies } = {}) =>
    ipcRenderer.invoke("butler:export-logs", { since, includeBodies: includeBodies === true }),
  getUsageHistory: ({ query = "" } = {}) => {
    const url = new URL(`/usage-history${String(query)}`, "http://local");
    if (url.pathname !== "/usage-history") throw new Error("Unsupported usage history route.");
    return requestJson(url.pathname + url.search, { method: "GET" });
  },
  getImageUsage: ({ days = 7 } = {}) => {
    const params = new URLSearchParams({ days: String(days) });
    return requestJson(`/usage/images?${params.toString()}`);
  },
  getUsageMonitor: ({ sessionId, sinceHours } = {}) => {
    const params = new URLSearchParams();
    if (sessionId) params.set("session_id", sessionId);
    if (sinceHours !== undefined) params.set("since_hours", String(sinceHours));
    const query = params.toString();
    return requestJson(query ? `/usage-monitor?${query}` : "/usage-monitor");
  },
  getProviderQuota: ({ providerId }) => {
    const params = new URLSearchParams({ provider_id: providerId });
    return requestJson(`/provider-quota?${params.toString()}`);
  },
  searchCommandPalette: ({ query = "" } = {}) => {
    const params = new URLSearchParams({ query });
    return requestJson(`/command-palette?${params.toString()}`);
  },
  getCanonGrants: ({ state }) => requestBridgeResult(`/canon/mcp-grants${state === "pending" ? "?state=pending" : ""}`),
  decideCanonGrant: ({ id, action }) => {
    if (!["allow", "deny", "revoke"].includes(action)) throw new Error("Invalid grant action");
    return requestCanonWrite(`/canon/mcp-grants/${encodeURIComponent(id)}/${action}`, "POST", {});
  },
  getCanonActivity: ({ id, before }) => requestBridgeResult(`/canon/epics/${encodeURIComponent(id)}/activity${before == null ? "" : `?before=${encodeURIComponent(before)}`}`),
  getCanonProposal: ({ id }) => requestBridgeResult(`/canon/proposals/${encodeURIComponent(id)}`),
  resolveCanonProposal: ({ id, body }) => requestCanonWrite(`/canon/proposals/${encodeURIComponent(id)}`, "POST", body),
  getCanonSidebar: ({ id }) => requestBridgeResult(`/projects/${encodeURIComponent(id)}/canon/sidebar`),
  orderCanonSidebar: ({ id, body }) => requestCanonWrite(`/projects/${encodeURIComponent(id)}/canon/sidebar-order`, "POST", body),
  linkCanonConversation: ({ id, sessionId }) => requestCanonWrite(`/canon/epics/${encodeURIComponent(id)}/conversation`, "POST", { session_id: sessionId }),
  getCanonTags: ({ id }) => requestBridgeResult(`/projects/${encodeURIComponent(id)}/canon/tags`),
  createCanonTag: ({ id, body }) => requestCanonWrite(`/projects/${encodeURIComponent(id)}/canon/tags`, "POST", body),
  editCanonTag: ({ id, body }) => requestCanonWrite(`/canon/tags/${encodeURIComponent(id)}`, "PATCH", body),
  deleteCanonTag: ({ id }) => requestBridgeResult(`/canon/tags/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getCanon: ({ id }) => requestBridgeResult(`/projects/${encodeURIComponent(id)}/canon`),
  getCanonPlan: ({ id }) => requestBridgeResult(`/canon/plans/${encodeURIComponent(id)}`),
  getEpicProgress: ({ id }) => requestBridgeResult(`/canon/epics/${encodeURIComponent(id)}/progress`),
  getCanonEpic: ({ id }) => requestBridgeResult(`/canon/epics/${encodeURIComponent(id)}`),
  createCanonPlan: ({ id, body }) => requestCanonWrite(`/projects/${encodeURIComponent(id)}/canon/plans`, "POST", body),
  editCanonPlan: ({ id, body }) => requestCanonWrite(`/canon/plans/${encodeURIComponent(id)}`, "PATCH", body),
  orderCanonPlan: ({ id, body }) => requestCanonWrite(`/canon/plans/${encodeURIComponent(id)}/order`, "POST", body),
  orderCanonBacklog: ({ id, body }) => requestCanonWrite(`/projects/${encodeURIComponent(id)}/canon/backlog/order`, "POST", body),
  createCanonEpic: ({ id, body }) => requestCanonWrite(`/projects/${encodeURIComponent(id)}/canon/epics`, "POST", body),
  editCanonEpic: ({ id, body }) => requestCanonWrite(`/canon/epics/${encodeURIComponent(id)}`, "PATCH", body),
  getSessionTaskGraphs: (input) => requestTaskGraph("sessions", "task-graphs", input),
  getPlanTaskGraph: (input) => requestTaskGraph("plans", "task-graph", input),
  getTaskDocument: (input) => requestTaskGraph("tasks", "document", input),
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
  exportDocument: (input) => ipcRenderer.invoke("butler:export-document", input),
  saveMessageFile: ({ fileId, suggestedName } = {}) =>
    ipcRenderer.invoke("butler:save-message-file", { fileId, suggestedName }),
  openMessageFile: ({ fileId } = {}) =>
    ipcRenderer.invoke("butler:open-message-file", { fileId }),
  getContextDetails: ({ sessionId }) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/context-details?${params.toString()}`);
  },
  listArtifacts: ({ sessionId }) => {
    const params = new URLSearchParams({ session_id: sessionId });
    return requestJson(`/artifacts?${params.toString()}`);
  },
  getMessageFileView: ({ fileId } = {}) => {
    if (typeof fileId !== "string" || !/^file-[0-9a-f-]{36}$/iu.test(fileId)) throw new Error("Invalid file");
    return requestBridgeResult(`/message-files/${encodeURIComponent(fileId)}/view`);
  },
  getPreviewView: ({ previewId, query = "" } = {}) => {
    if (typeof previewId !== "string" || !/^p-[a-f0-9]{64}$/u.test(previewId)) throw new Error("Invalid preview");
    const path = `/previews/${encodeURIComponent(previewId)}/view`;
    const url = new URL(path + String(query), "http://local");
    if (url.pathname !== path) throw new Error("Unsupported preview route.");
    return requestBridgeResult(url.pathname + url.search);
  },
  getOutputView: ({ outputId, revision } = {}) => {
    if (typeof outputId !== "string" || !/^[a-f0-9]{64}$/u.test(outputId)) throw new Error("Invalid output");
    const params = new URLSearchParams();
    if (revision !== undefined) {
      if (!Number.isSafeInteger(Number(revision)) || Number(revision) < 1) throw new Error("Invalid revision");
      params.set("revision", String(revision));
    }
    return requestBridgeResult(`/outputs/${outputId}/view?${params.toString()}`);
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
  // Schedule saves return the bridge envelope so a refused save keeps its
  // code and status (the form shows 400s inline). An omitted accessMode lets
  // the gateway use the target conversation's current mode.
  createAutomation: ({ title, promptBody, targetSessionId, intervalSeconds, accessMode, model, schedule, scheduleType, runAt, startAt }) => requestBridgeResult("/automations", {
    method: "POST",
    body: JSON.stringify({
      title,
      prompt_body: promptBody,
      target_session_id: targetSessionId,
      interval_seconds: intervalSeconds,
      access_mode: accessMode,
      model,
      schedule,
      schedule_type: scheduleType,
      run_at: runAt,
      start_at: startAt,
    }),
  }),
  updateAutomation: ({ automationId, title, promptBody, targetSessionId, intervalSeconds, state, accessMode, model, schedule, scheduleType, runAt, startAt }) =>
    requestBridgeResult(`/automations/${encodeURIComponent(automationId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        prompt_body: promptBody,
        target_session_id: targetSessionId,
        interval_seconds: intervalSeconds,
        state,
        access_mode: accessMode,
        model,
        schedule,
        schedule_type: scheduleType,
        run_at: runAt,
        start_at: startAt,
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

function requestCanonWrite(path, method, body) {
  return requestBridgeResult(path, { method, body: JSON.stringify(body) });
}

// Keep the sandboxed preload self-contained, on its existing authenticated channel.
function requestTaskGraph(scope, tail, { id, revision, cursor, limit } = {}) {
  const query = new URLSearchParams();
  if (revision) query.set("revision", revision);
  if (cursor) query.set("cursor", cursor);
  if (limit !== undefined) query.set("limit", String(limit));
  const suffix = query.size ? `?${query}` : "";
  return requestJson(`/${scope}/${encodeURIComponent(id)}/${tail}${suffix}`);
}
const browserCall = (op, input) => ipcRenderer.invoke("butler-browser:call", op, input);
const frameSubscriptions = new Map();
// Last frame per subscribed tab, so a second consumer of a static (or frozen) tab draws at once.
const lastFrames = new Map();
ipcRenderer.on("browser:frame", (_event, frame) => { if (frameSubscriptions.has(frame.tab)) lastFrames.set(frame.tab, frame); });
const pendingFrameTabs = new Set();
const frameCall = (op, input) => ipcRenderer.invoke("butler-browser:call", op, input).catch(() => {});
function subscribeFrame(tabId) {
  const viewers = frameSubscriptions.get(tabId);
  if (!viewers?.size) return;
  const widthPx = Math.max(...viewers.values());
  void ipcRenderer.invoke("butler-browser:call", "frame.subscribe", { id: tabId, widthPx })
    .then(() => pendingFrameTabs.delete(tabId))
    .catch(() => { if (frameSubscriptions.has(tabId)) pendingFrameTabs.add(tabId); });
}
ipcRenderer.on("butler-browser:state", (_event, state) => {
  for (const tab of state.tabs ?? []) if (pendingFrameTabs.has(tab.id) && (tab.agent || tab.driven)) subscribeFrame(tab.id);
});
let frameVisibilityWatching = false;

contextBridge.exposeInMainWorld("butlerBrowser", {
  onFrame(tabId, handler, widthPx = 416) {
    if (!frameVisibilityWatching) {
      frameVisibilityWatching = true;
      document.addEventListener("visibilitychange", () => {
        if (frameSubscriptions.size) void frameCall("frame.visibility", { value: !document.hidden });
      });
    }
    const listener = (_event, frame) => { if (frame.tab === tabId) handler(frame); };
    ipcRenderer.on("browser:frame", listener);
    const viewers = frameSubscriptions.get(tabId) ?? new Map();
    const count = viewers.size, token = Symbol();
    const width = Number.isFinite(widthPx) ? Math.max(48, Math.min(416, Math.round(widthPx))) : 416;
    viewers.set(token, width); frameSubscriptions.set(tabId, viewers);
    let active = true;
    if (!count) {
      void frameCall("frame.visibility", { value: !document.hidden });
    } else if (lastFrames.has(tabId)) {
      const frame = lastFrames.get(tabId);
      queueMicrotask(() => { if (active) handler(frame); });
    }
    subscribeFrame(tabId);
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener("browser:frame", listener);
      viewers.delete(token);
      if (viewers.size) subscribeFrame(tabId);
      else { frameSubscriptions.delete(tabId); pendingFrameTabs.delete(tabId); lastFrames.delete(tabId); void frameCall("frame.unsubscribe", { id: tabId }); }
    };
  },
  onDownload(handler) {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("butler-browser:download", listener);
    return () => ipcRenderer.removeListener("butler-browser:download", listener);
  },
  onElementDrag(handler) {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("butler-browser:element-drag", listener);
    return () => ipcRenderer.removeListener("butler-browser:element-drag", listener);
  },
  onSelectionAction(handler) {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("butler-browser:selection-action", listener);
    return () => ipcRenderer.removeListener("butler-browser:selection-action", listener);
  },
  call: browserCall,
  subscribe: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("butler-browser:state", listener);
    browserCall("state").then(handler);
    return () => ipcRenderer.removeListener("butler-browser:state", listener);
  },
  onPointer: (handler) => {
    const listener = (_event, point) => handler(point);
    ipcRenderer.on("butler-browser:pointer", listener);
    return () => ipcRenderer.removeListener("butler-browser:pointer", listener);
  },
  onStill: (handler) => {
    const listener = (_event, receipt) => handler(receipt);
    ipcRenderer.on("butler-browser:still-delivered", listener);
    return () => ipcRenderer.removeListener("butler-browser:still-delivered", listener);
  },
  onHistory: (handler) => {
    const listener = () => handler(); ipcRenderer.on("butler-browser:history", listener);
    return () => ipcRenderer.removeListener("butler-browser:history", listener);
  },
  onAddress: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("butler-browser:address", listener);
    return () => ipcRenderer.removeListener("butler-browser:address", listener);
  },
});

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_ADMIN_HEADER } from "./app-security-admin.mjs";

// Settings > General > reset everything (desktop only). Main sends the request
// with the admin credential, then stops the Agent (the Agent moves its data
// away while it shuts down), clears the App's own storage and relaunches.

/** The fixed token the Agent checks; the localized phrase the user types never leaves the renderer. */
export const FULL_RESET_CONFIRMATION = "reset-all-data";
/** userData files and folders owned by the App shell that a reset removes. */
export const FULL_RESET_USER_DATA_PATHS = Object.freeze(["browser", "browser-downloads", "butler-native-settings.json"]);
/** userData marker: the data generation before a reset, to detect a reset that kept the old data. */
export const FULL_RESET_PENDING_FILE = "full-reset-pending.json";
const PENDING_SCHEMA = "butler.app.full-reset-pending.v1";
const APP_PROTOCOL_VERSION = "butler.app.v1";
const BRIDGE_ERROR_SCHEMA = "butler.app.bridge-error.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const OPERATION_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * GET a fresh single-use nonce, then POST the reset. Answers the preload's
 * bridge envelope: `{ ok: true }` on 202, else a bounded error code.
 */
export async function requestFullReset(input, { ensureReady, fetch, serverUrl, authHeaders, adminCredential }) {
  const operationId = input?.operationId;
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) return failure("invalid_request");
  try {
    await ensureReady();
    const headers = {
      ...(await authHeaders()),
      ...(adminCredential ? { [APP_ADMIN_HEADER]: adminCredential } : {}),
    };
    const nonce = await send(fetch, new URL("/data/reset", serverUrl), { method: "GET", headers });
    if (!nonce.ok) return nonce;
    if (typeof nonce.data?.nonce !== "string") return failure("invalid_protocol");
    const accepted = await send(fetch, new URL("/data/reset", serverUrl), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: operationId, nonce: nonce.data.nonce, confirmation: FULL_RESET_CONFIRMATION }),
    });
    return accepted.ok ? { ok: true } : accepted;
  } catch (error) {
    return failure(error?.code);
  }
}

async function send(fetch, url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) return failure(body?.error?.code, response.status);
  if (body?.protocol_version !== APP_PROTOCOL_VERSION) return failure("invalid_protocol", response.status);
  return { ok: true, data: body.data };
}

/**
 * After an accepted reset: stop the Agent, then clear what the App keeps
 * outside the data folder (renderer storage, the signed-in browser
 * partition and its files), then relaunch. The renderer is moved off the app
 * first so it cannot write its caches back. The storage-migration marker in
 * userData stays, or legacy storage would be copied back.
 */
export async function relaunchAfterFullReset({
  userDataPath,
  previousGeneration,
  stopAgent,
  quiesceRenderer,
  clearSessions,
  relaunch,
  log = () => undefined,
}) {
  // Every step that fails still relaunches: the Agent applies an accepted
  // reset at its next start (it also stops itself shortly after the
  // request), and the next launch clears App data again when it sees the
  // new data generation.
  const warn = (step) => (error) => log(`full reset ${step} failed: ${error?.message ?? "unknown"}`);
  try {
    await quiesceRenderer().catch(warn("renderer"));
    await stopAgent().catch(warn("agent stop"));
    if (previousGeneration) await writePendingMarker(userDataPath, previousGeneration).catch(warn("marker"));
    await clearAppOwnedData({ userDataPath, clearSessions }).catch(warn("clear"));
  } finally {
    relaunch();
  }
}

/** Clears renderer storage, the signed-in browser partition and the App's own userData files. */
export async function clearAppOwnedData({ userDataPath, clearSessions }) {
  await clearSessions();
  for (const path of FULL_RESET_USER_DATA_PATHS) await rm(join(userDataPath, path), { recursive: true, force: true });
}

async function writePendingMarker(userDataPath, previousGeneration) {
  await writeFile(join(userDataPath, FULL_RESET_PENDING_FILE),
    `${JSON.stringify({ schema: PENDING_SCHEMA, previous_data_generation: previousGeneration })}\n`, { mode: 0o600 });
}

function failure(code, status) {
  const safeStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  return {
    ok: false,
    error: {
      schema: BRIDGE_ERROR_SCHEMA,
      code: typeof code === "string" && SAFE_CODE.test(code) ? code : "request_failed",
      ...(safeStatus === undefined ? {} : { status: safeStatus }),
    },
  };
}

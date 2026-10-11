import { readFileSync } from "node:fs";
import { join } from "node:path";

// Settings → Security (#229) calls carry an admin credential next to the
// bearer token: header-less forwarders (ssh -L, socat, tailscale serve) make
// remote requests look local, so the gateway no longer trusts loopback alone.
// The names below follow #275 (`local_admin.rs`, `ADMIN_CREDENTIAL_HEADER`).

/** The admin credential file, relative to the data folder (0600, created by the Agent, never shown). */
export const APP_LOCAL_ADMIN_FILE = ["app", "runtime", "auth", "local-admin.json"];
/** The file is valid only with exactly this schema. */
export const APP_LOCAL_ADMIN_SCHEMA = "butler.app-local-admin.v1";
/** The field of that file holding the credential. */
export const APP_LOCAL_ADMIN_FIELD = "secret";
/** Shorter secrets count as missing, as in the Agent. */
export const APP_LOCAL_ADMIN_MIN_LENGTH = 32;
/** The request header that carries it (lower case, as fetch sends it). */
export const APP_ADMIN_HEADER = "x-butler-admin";

const APP_PROTOCOL_VERSION = "butler.app.v1";
const BRIDGE_ERROR_SCHEMA = "butler.app.bridge-error.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const HEADER_VALUE = /^[\x21-\x7e]+$/u;

/** The only calls that carry the admin credential, by bridge route. */
const SECURITY_ROUTES = Object.freeze({
  getHooks: { method: "GET", path: "/hooks" },
  saveHooks: { method: "PUT", path: "/hooks" },
  getHookRuns: { method: "GET", path: "/hooks/runs" },
  testHook: { method: "POST", path: "/hooks", hook: true },
  getSecurity: { method: "GET", path: "/security" },
  issuePairingCode: { method: "POST", path: "/security/pairing" },
  getPairingStatus: { method: "GET", path: "/security/pairing" },
  listPairedDevices: { method: "GET", path: "/security/devices" },
  revokePairedDevice: { method: "DELETE", path: "/security/devices", device: true },
  revokeAllPairedDevices: { method: "DELETE", path: "/security/devices" },
  rotateConnectionCode: { method: "POST", path: "/security/connection-code/rotate" },
  // PATCH /settings only when it carries `security`; other settings go
  // through the preload as before.
  updateSecuritySettings: { method: "PATCH", path: "/settings" },
  // Sign-ins: passwords pass through main to the Agent's keychain store only.
  listSignIns: { method: "GET", path: "/security/signins" },
  addSignIn: { method: "POST", path: "/security/signins", payload: true },
  saveSignIn: { method: "POST", path: "/security/signins", payload: true },
  updateSignIn: { method: "PATCH", path: "/security/signins", entry: true, payload: true },
  deleteSignIn: { method: "DELETE", path: "/security/signins", entry: true },
  updateSignInSite: { method: "POST", path: "/security/signins/site", payload: true },
  listImportSources: { method: "GET", path: "/security/browser-import/sources" },
  previewImport: { method: "POST", path: "/security/browser-import/preview", payload: true },
  runImport: { method: "POST", path: "/security/browser-import/run", payload: true },
});
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Only the app's own renderer may ask main for a security call:
 * `app://butler`, plus the dev UI origin in dev.
 */
export function isSecuritySenderOrigin(origin, { appOrigin, devOrigin = null }) {
  return typeof origin === "string" && (origin === appOrigin || (devOrigin !== null && origin === devOrigin));
}

export function appLocalAdminPath(butlerData) {
  return join(butlerData, ...APP_LOCAL_ADMIN_FILE);
}

/**
 * The admin credential, or null when the file is missing or invalid (an
 * Agent older than #275). Read on every security call, so Retry picks up a
 * file the Agent created later. It does not change when the connection
 * code rotates. Main only: never log it or pass it to the renderer.
 */
export function readAppLocalAdmin({ butlerData }) {
  try {
    const stored = JSON.parse(readFileSync(appLocalAdminPath(butlerData), "utf8"));
    const value = stored?.[APP_LOCAL_ADMIN_FIELD];
    return stored?.schema === APP_LOCAL_ADMIN_SCHEMA &&
      typeof value === "string" &&
      value.length >= APP_LOCAL_ADMIN_MIN_LENGTH &&
      HEADER_VALUE.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Sends one security route from main with the bearer token and, when there
 * is one, the admin credential. Answers the preload's bridge envelope: the
 * data, or a bounded error code and status (never response text or headers).
 * `authHeaders` is read after `ensureReady`, which may have re-read a token
 * rotated elsewhere. `onRotated` runs after a successful rotation (the
 * token re-read).
 */
export async function requestSecurityRoute(
  input,
  { ensureReady, fetch, serverUrl, authHeaders, adminCredential, onRotated = () => {} },
) {
  const route = typeof input?.route === "string" && Object.hasOwn(SECURITY_ROUTES, input.route)
    ? SECURITY_ROUTES[input.route]
    : null;
  const deviceId = input?.body?.deviceId;
  if (route?.device && (typeof deviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(deviceId))) {
    return failure("invalid_request");
  }
  const hookId = input?.body?.hookId;
  if (route?.hook && (typeof hookId !== "string" || !/^[a-z0-9_-]{1,128}$/iu.test(hookId))) return failure("invalid_request");
  const entryId = input?.body?.id;
  if (route?.entry && (typeof entryId !== "string" || !ENTRY_ID.test(entryId))) return failure("invalid_request");
  const payload = input?.body?.payload;
  if (route?.payload && (typeof payload !== "object" || payload === null)) return failure("invalid_request");
  const path = route?.hook ? `${route.path}/${hookId}/test` : route?.device ? `${route.path}/${encodeURIComponent(deviceId)}` : route?.entry ? `${route.path}/${entryId}` : route?.path;
  const security = input?.body?.security;
  const needsBody = input?.route === "updateSecuritySettings" || input?.route === "saveHooks" || route?.hook || route?.payload;
  if (!route || (input?.route === "updateSecuritySettings" && (typeof security !== "object" || security === null))) {
    return failure("invalid_request");
  }
  try {
    await ensureReady();
    const bearer = await authHeaders();
    const response = await fetch(new URL(path, serverUrl), {
      method: route.method,
      headers: {
        ...(needsBody ? { "content-type": "application/json" } : {}),
        ...bearer,
        ...(adminCredential ? { [APP_ADMIN_HEADER]: adminCredential } : {}),
      },
      ...(needsBody ? { body: JSON.stringify(route?.payload ? payload : input?.route === "saveHooks" ? input.body : route?.hook ? {} : { security }) } : {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return failure(body?.error?.code, response.status);
    if (body?.protocol_version !== APP_PROTOCOL_VERSION) return failure("invalid_protocol", response.status);
    if (input.route === "rotateConnectionCode") onRotated();
    return { ok: true, data: body.data };
  } catch (error) {
    return failure(error?.code);
  }
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

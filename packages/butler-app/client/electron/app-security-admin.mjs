import { readFileSync } from "node:fs";
import { join } from "node:path";

// Settings → Security (#229) calls carry an admin credential next to the
// bearer token: header-less forwarders (ssh -L, socat, tailscale serve) make
// remote requests look local, so the gateway no longer trusts loopback alone.
// The names below are not final in #275; rename them here only.

/** The admin credential file, relative to the data folder (0600, never shown). */
export const APP_LOCAL_ADMIN_FILE = ["app", "runtime", "auth", "local-admin.json"];
/** The field of that file holding the credential. */
export const APP_LOCAL_ADMIN_FIELD = "token";
/** The request header that carries it (lower case, as fetch sends it). */
export const APP_ADMIN_HEADER = "x-butler-admin";

const APP_PROTOCOL_VERSION = "butler.app.v1";
const BRIDGE_ERROR_SCHEMA = "butler.app.bridge-error.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const HEADER_VALUE = /^[\x21-\x7e]+$/u;

/** The only calls that carry the admin credential, by bridge route. */
const SECURITY_ROUTES = Object.freeze({
  getSecurity: { method: "GET", path: "/security" },
  revealConnectionCode: { method: "POST", path: "/security/connection-code/reveal" },
  rotateConnectionCode: { method: "POST", path: "/security/connection-code/rotate" },
  // PATCH /settings only when it carries `security`; other settings go
  // through the preload as before.
  updateSecuritySettings: { method: "PATCH", path: "/settings" },
});

export function appLocalAdminPath(butlerData) {
  return join(butlerData, ...APP_LOCAL_ADMIN_FILE);
}

/**
 * The admin credential, or null when the file is missing or invalid (an
 * Agent older than #275). It does not change when the connection code
 * rotates. Main only: never log it or pass it to the renderer.
 */
export function readAppLocalAdmin({ butlerData }) {
  try {
    const value = JSON.parse(readFileSync(appLocalAdminPath(butlerData), "utf8"))?.[APP_LOCAL_ADMIN_FIELD];
    return typeof value === "string" && HEADER_VALUE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Sends one security route from main with the bearer token and, when there
 * is one, the admin credential. Answers the preload's bridge envelope: the
 * data, or a bounded error code and status (never response text or headers).
 * `onRotated` runs after a successful rotation (the token re-read).
 */
export async function requestSecurityRoute(
  input,
  { ensureReady, fetch, serverUrl, authHeaders, adminCredential, onRotated = () => {} },
) {
  const route = typeof input?.route === "string" && Object.hasOwn(SECURITY_ROUTES, input.route)
    ? SECURITY_ROUTES[input.route]
    : null;
  const security = input?.body?.security;
  const needsBody = input?.route === "updateSecuritySettings";
  if (!route || (needsBody && (typeof security !== "object" || security === null))) {
    return failure("invalid_request");
  }
  try {
    await ensureReady();
    const response = await fetch(new URL(route.path, serverUrl), {
      method: route.method,
      headers: {
        ...(needsBody ? { "content-type": "application/json" } : {}),
        ...authHeaders,
        ...(adminCredential ? { [APP_ADMIN_HEADER]: adminCredential } : {}),
      },
      ...(needsBody ? { body: JSON.stringify({ security }) } : {}),
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

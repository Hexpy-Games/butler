import { networkLog } from "../log/runtime.mjs";
import { agentPopupAllowed } from "./popup-policy.mjs";
import { isIP } from "node:net";
import { webUrl } from "./policy.mjs";
import { signedInPlace } from "./signed-in.mjs";
import { noteRequestFinished, noteRequestStarted } from "./devtools.mjs";

export function privateAddress(address) {
  const v = address.toLowerCase().replace(/^::ffff:/u, "");
  if (v.includes(":")) return v === "::" || v === "::1" || /^(fc|fd|fe[89ab]|ff)/u.test(v);
  const [a, c] = v.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && c === 254) || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127);
}
export async function guardUrl(raw, profile, policy = {}, mainFrame = true) {
  if (!await publicUrl(raw, profile, policy)) return false;
  // Signed-in tabs reach only granted sites and identity pages at top level.
  return policy.mode !== "signed_in" || !mainFrame || signedInPlace(raw, policy) !== "denied";
}
async function publicUrl(raw, profile, policy) {
  const value = webUrl(raw);
  if (!value) return false;
  const url = new URL(value);
  if (url.username || url.password) return false;
  if (policy.content_origin === url.origin && (url.pathname.startsWith("/__o/") || policy.preview === true)) return true;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIP(host)) return !privateAddress(host);
  try {
    const answer = await profile.resolveHost(host);
    return answer.endpoints.length > 0 && answer.endpoints.every(endpoint => !privateAddress(endpoint.address));
  } catch { return false; }
}
/** Installed once per profile: the listeners a tab's request tracking and guard share. */
function profileRouter(profile) {
  const router = routers.get(profile) ?? new Map();
  if (!routers.has(profile)) {
    routers.set(profile, router);
    // In-flight page requests (fetch/XHR) let observe-after-act wait for results.
    const finished = detail => {
      networkLog("browser.completed", detail.url, { status: detail.statusCode, error: detail.error });
      const entry = router.get(detail.webContentsId);
      if (!entry) return;
      entry.tab.pendingRequests?.delete(detail.id);
      noteRequestFinished(entry.tab, detail);
    };
    profile.webRequest.onCompleted(finished);
    profile.webRequest.onErrorOccurred(finished);
    profile.webRequest.onBeforeRequest((detail, done) => {
      networkLog("browser.request", detail.url, { method: detail.method, type: detail.resourceType });
      const entry = router.get(detail.webContentsId);
      if (entry) noteRequestStarted(entry.tab, detail);
      if (entry && detail.resourceType === "xhr") (entry.tab.pendingRequests ??= new Map()).set(detail.id, Date.now());
      // A tab that only tracks requests has no guard: my tabs remain outside this policy.
      if (!entry?.onViolation || !["mainFrame", "subFrame"].includes(detail.resourceType)) { done({}); return; }
      // While the user holds a pop-up (a card company's 3-D Secure page, say) they browse freely.
      if (detail.resourceType === "mainFrame" && entry.tab.opener && entry.tab.holder !== "user" && !agentPopupAllowed(entry.tab.policy, entry.tab.popupParentUrl, detail.url)) {
        done({ cancel: true }); entry.onViolation(detail.url); return;
      }
      // While the user holds the tab they browse freely; Rust re-checks the page at hand-back.
      const policy = entry.tab.holder === "user" ? { ...entry.tab.policy, mode: undefined } : entry.tab.policy;
      void guardUrl(detail.url, profile, policy, detail.resourceType === "mainFrame").then(allowed => {
        done({ cancel: !allowed }); if (!allowed) entry.onViolation();
      });
    });
  }
  return router;
}
/** Request rows for a tab with no guard yet; a later guard takes over its entry. */
export function trackRequests(tab) {
  const contents = tab.view.webContents;
  const router = profileRouter(contents.session);
  if (router.has(contents.id)) return;
  router.set(contents.id, { tab });
  contents.once("destroyed", () => router.delete(contents.id));
}
export function installNavigationGuard(tab, onViolation) {
  const contents = tab.view.webContents;
  const router = profileRouter(contents.session);
  router.set(contents.id, { tab, onViolation });
  contents.once("destroyed", () => router.delete(contents.id));
  contents.on("will-frame-navigate", event => {
    if ((!event.isMainFrame || tab.opener && event.url === "about:blank") && /^about:(blank|srcdoc)$/u.test(event.url)) return;
    if (!webUrl(event.url)) { event.preventDefault(); onViolation(); }
  });
}
const routers = new WeakMap();

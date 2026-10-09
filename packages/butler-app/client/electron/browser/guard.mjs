import { agentPopupAllowed } from "./popup-policy.mjs";
import { isIP } from "node:net";
import { webUrl } from "./policy.mjs";

export function privateAddress(address) {
  const v = address.toLowerCase().replace(/^::ffff:/u, "");
  if (v.includes(":")) return v === "::" || v === "::1" || /^(fc|fd|fe[89ab]|ff)/u.test(v);
  const [a, c] = v.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && c === 254) || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127);
}
export async function guardUrl(raw, profile, policy = {}) {
  const value = webUrl(raw);
  if (!value) return false;
  const url = new URL(value);
  if (url.username || url.password) return false;
  if (policy.content_origin === url.origin && url.pathname.startsWith("/__o/")) return true;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIP(host)) return !privateAddress(host);
  try {
    const answer = await profile.resolveHost(host);
    return answer.endpoints.length > 0 && answer.endpoints.every(endpoint => !privateAddress(endpoint.address));
  } catch { return false; }
}
export function installNavigationGuard(tab, onViolation) {
  const contents = tab.view.webContents;
  // Installed once per profile. Frame requests only; my tabs remain outside this policy.
  const profile = contents.session;
  const router = routers.get(profile) ?? new Map();
  if (!routers.has(profile)) {
    routers.set(profile, router);
    profile.webRequest.onBeforeRequest((detail, done) => {
      const entry = router.get(detail.webContentsId);
      if (!entry || !["mainFrame", "subFrame"].includes(detail.resourceType)) { done({}); return; }
      if (detail.resourceType === "mainFrame" && entry.tab.opener && !agentPopupAllowed(entry.tab.policy, entry.tab.popupParentUrl, detail.url)) {
        done({ cancel: true }); entry.onViolation(detail.url); return;
      }
      void guardUrl(detail.url, profile, entry.tab.policy).then(allowed => {
        done({ cancel: !allowed }); if (!allowed) entry.onViolation();
      });
    });
  }
  router.set(contents.id, { tab, onViolation });
  contents.once("destroyed", () => router.delete(contents.id));
  contents.on("will-frame-navigate", event => {
    if ((!event.isMainFrame || tab.opener && event.url === "about:blank") && /^about:(blank|srcdoc)$/u.test(event.url)) return;
    if (!webUrl(event.url)) { event.preventDefault(); onViolation(); }
  });
}
const routers = new WeakMap();

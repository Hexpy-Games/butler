import { webUrl } from "./policy.mjs";
/** Rust supplies site keys and exact auth/utility hosts; page content cannot extend them. */
export function agentPopupAllowed(policy, parent, raw) {
  const url = webUrl(raw);
  if (!url) return raw === "about:blank";
  const target = new URL(url);
  const host = target.hostname;
  const sameOrigin = webUrl(parent) && new URL(parent).origin === target.origin;
  const inSite = site => host === site || host.endsWith(`.${site}`);
  // A payment provider's checkout window (PG pop-up) may open; acting in it keeps its per-act card.
  return Boolean(sameOrigin || policy.popup_sites?.some(inSite) || policy.popup_hosts?.includes(host) || policy.payment_sites?.some(inSite));
}

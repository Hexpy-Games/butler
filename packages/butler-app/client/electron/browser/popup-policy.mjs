import { webUrl } from "./policy.mjs";
/** Rust supplies site keys and exact auth/utility hosts; page content cannot extend them. */
export function agentPopupAllowed(policy, parent, raw) {
  const url = webUrl(raw);
  if (!url) return raw === "about:blank";
  const target = new URL(url);
  const host = target.hostname;
  const sameOrigin = webUrl(parent) && new URL(parent).origin === target.origin;
  return Boolean(sameOrigin || policy.popup_sites?.some(site => host === site || host.endsWith(`.${site}`)) || policy.popup_hosts?.includes(host));
}

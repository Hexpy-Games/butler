import { webUrl } from "./policy.mjs";

/** Signed-in policy enforcement. Rust computes every site (eTLD+1) and grant;
 * main only matches hosts against them and reports frame classes back. */
const inSite = (host, site) => host === site || host.endsWith(`.${site}`);
const hostOf = raw => { try { return new URL(raw).hostname.toLowerCase().replace(/\.$/u, ""); } catch { return ""; } };

export function signedInPolicy(tab) { return tab.profile === "signed_in" && tab.policy?.mode === "signed_in" ? tab.policy : null; }

export function identityPage(raw, policy) {
  const value = webUrl(raw);
  if (!value) return false;
  const url = new URL(value);
  return url.protocol === "https:" && (policy.idp_pages ?? []).some(page => page.host === url.hostname && (!page.paths?.length || page.paths.some(path => url.pathname.startsWith(path))));
}

/** "granted" | "identity" | "denied" for a top-level URL. */
export function signedInPlace(raw, policy) {
  const host = hostOf(raw);
  if (!host || !webUrl(raw)) return "denied";
  if ((policy.sites ?? []).some(site => inSite(host, site))) return "granted";
  return identityPage(raw, policy) ? "identity" : "denied";
}

function topSite(raw, policy) {
  const host = hostOf(raw);
  return (policy.sites ?? []).find(site => inSite(host, site))
    ?? (policy.idp_pages ?? []).find(page => page.host === host)?.site ?? host;
}

/** Decision 37 frame classes: every frame is open to the agent; payment frames show labels only. */
export function frameClass(raw, topUrl, policy) {
  if (/^about:(blank|srcdoc)$/u.test(raw ?? "") || !raw) return "granted";
  const host = hostOf(raw), top = topSite(topUrl, policy);
  if (!host) return "cross_site";
  if ((policy.payment_sites ?? []).some(site => inSite(host, site))) return "payment";
  if (inSite(host, top) || (policy.sites ?? []).some(site => inSite(host, site))) return "granted";
  if ((policy.utility_hosts ?? []).includes(host)) return "utility";
  return "cross_site";
}

/** Rust sends the live policy with every signed-in call; a revoked grant fences at once. */
export function applySignedInPolicy(tab, policy) {
  if (tab.profile !== "signed_in") return true;
  if (policy?.mode !== "signed_in") return false;
  const before = JSON.stringify(tab.policy?.sites ?? []);
  tab.policy = policy;
  if (before !== JSON.stringify(policy.sites ?? [])) tab.observation = null;
  return signedInPlace(tab.url, policy) !== "denied";
}

/** A revoked site fences every conversation tab on it: agent tabs close, the user's handed-over tabs return to the user. */
export function revokeSignedInSite(browser, site, controlTab) {
  for (const tab of [...browser.tabs.values()]) {
    if (tab.owner === "mine" || tab.profile !== "signed_in" || !inSite(hostOf(tab.url), site) && !(tab.policy?.sites ?? []).includes(site)) continue;
    tab.policy = { ...tab.policy, sites: (tab.policy?.sites ?? []).filter(item => item !== site) };
    tab.epoch++; tab.observation = null; tab.cancelled = true;
    if (tab.agent) browser.close(tab.id); else controlTab(browser, tab, "user", true);
  }
}

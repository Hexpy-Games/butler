import { session } from "electron";

/**
 * Settings › Browser › "Cookies and cache": cookies, site storage (local
 * storage, IndexedDB, service workers, cache storage), the HTTP cache and
 * HTTP sign-ins of the signed-in profile and of every open conversation tab.
 * Saved sign-ins and payment methods stay in the Agent's keychain store, and
 * history and bookmarks in the Agent; none of them live in these profiles.
 */
export async function clearSiteData(browser) {
  const partitions = new Set(["persist:butler-web", ...[...browser.tabs.values()].map(tab => tab.partition)]);
  for (const partition of partitions) {
    const profile = session.fromPartition(partition);
    await profile.clearStorageData();
    await profile.clearCache();
    await profile.clearAuthCache();
  }
  return { profiles: partitions.size };
}

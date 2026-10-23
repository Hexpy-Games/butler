import { ipcMain } from "electron";

/** "로그인 저장" after a takeover sign-in in a conversation's signed-in tab.
 * The page's own form values reach main only from signed-in tabs, are kept
 * in memory for at most two minutes, and leave main only to the keychain store. */
const OFFER_MS = 120_000;

export function installSignInOffers(browser) {
  ipcMain.on("butler-browser:signin-candidate", async (event, input) => {
    const tab = [...browser.tabs.values()].find(item => item.view?.webContents === event.sender);
    const frame = event.senderFrame;
    if (!tab || !frame || tab.owner === "mine" || tab.profile !== "signed_in" || tab.holder !== "user") return;
    let origin;
    try { origin = new URL(tab.view.webContents.getURL()).origin; } catch { return; }
    // Only the top-level page's own origin, never a framed form.
    if (frame.origin !== origin) return;
    const username = typeof input?.username === "string" ? input.username.slice(0, 256) : "";
    const password = typeof input?.password === "string" && input.password.length <= 1024 ? input.password : "";
    if (!username || !password) return;
    // Without a password store there is nothing to save to, so nothing is offered.
    if (!await browser.signInStoreAvailable?.().catch(() => false) || tab.closing || browser.tabs.get(tab.id) !== tab) return;
    clearOffer(tab);
    tab.saveOffer = { origin, username, password, timer: setTimeout(() => { clearOffer(tab); browser.publish(); }, OFFER_MS) };
    browser.publish();
  });
}

export function clearOffer(tab) {
  if (!tab?.saveOffer) return;
  clearTimeout(tab.saveOffer.timer);
  tab.saveOffer.password = null;
  tab.saveOffer = null;
}

/** Saves the offered sign-in. The offer, and its password, leave main once saved;
 * a failed save keeps it for another try until it expires. */
export function saveOffer(browser, id) {
  const offer = browser.tabs.get(id)?.saveOffer;
  if (!offer) return Promise.resolve({ ok: false, error: { code: "signin_offer_expired" } });
  offer.saving ??= save(browser, id, offer).finally(() => { offer.saving = null; });
  return offer.saving;
}

async function save(browser, id, offer) {
  const input = { origin: offer.origin, username: offer.username, password: offer.password };
  try {
    const result = await browser.saveSignIn?.(input) ?? { ok: false, error: { code: "signin_unavailable" } };
    const tab = browser.tabs.get(id);
    if (result?.ok && tab?.saveOffer === offer) { clearOffer(tab); browser.publish(); }
    return result;
  } finally { input.password = null; }
}

import { ipcMain } from "electron";

/** "로그인 저장" after a takeover sign-in in a conversation's signed-in tab.
 * The page's own form values reach main only from signed-in tabs, are kept
 * in memory for at most two minutes, and leave main only to the keychain store. */
const OFFER_MS = 120_000;

export function installSignInOffers(browser) {
  ipcMain.on("butler-browser:signin-candidate", (event, input) => {
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

/** Saves the offered sign-in; the password is dropped from main either way. */
export async function saveOffer(browser, id) {
  const tab = browser.tabs.get(id);
  const offer = tab?.saveOffer;
  if (!offer) return { ok: false, error: { code: "signin_offer_expired" } };
  const input = { origin: offer.origin, username: offer.username, password: offer.password };
  clearOffer(tab); browser.publish();
  try { return await browser.saveSignIn?.(input) ?? { ok: false, error: { code: "signin_unavailable" } }; }
  finally { input.password = null; }
}

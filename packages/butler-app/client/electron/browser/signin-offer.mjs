import { ipcMain } from "electron";

/** "로그인 저장" after the user signs in in a signed-in tab they hold (their own tab,
 * or a conversation tab they took over); not offered when the site already has this exact sign-in saved.
 * The page's own form values reach main only from signed-in tabs, are kept
 * in memory for at most two minutes, and leave main only to the keychain store.
 * A username step is remembered per tab and origin for five minutes, in memory only. */
const OFFER_MS = 120_000;
const USERNAME_MS = 300_000;

export function installSignInOffers(browser) {
  ipcMain.on("butler-browser:signin-username", (event, input) => {
    const tab = [...browser.tabs.values()].find(item => item.view?.webContents === event.sender);
    const frame = event.senderFrame;
    if (!tab || !frame || tab.profile !== "signed_in" || tab.holder !== "user") return;
    let origin;
    try { origin = new URL(tab.view.webContents.getURL()).origin; } catch { return; }
    const username = typeof input?.username === "string" ? input.username.trim().slice(0, 256) : "";
    if (!username) return;
    rememberUsername(tab, origin, frame.origin, username);
  });
  ipcMain.on("butler-browser:signin-candidate", (event, input) => {
    const tab = [...browser.tabs.values()].find(item => item.view?.webContents === event.sender);
    const frame = event.senderFrame;
    if (!tab || !frame || tab.profile !== "signed_in" || tab.holder !== "user") return;
    let origin;
    try { origin = new URL(tab.view.webContents.getURL()).origin; } catch { return; }
    const frameOrigin = frame.parent ? frame.origin : undefined;
    const pending = tab.pendingUsername;
    const username = (typeof input?.username === "string" ? input.username.slice(0, 256) : "") ||
      (pending?.origin === origin && pending.frameOrigin === frame.origin ? pending.username : "");
    const password = typeof input?.password === "string" && input.password.length <= 1024 ? input.password : "";
    if (!username || !password) return;
    offerSignIn(browser, tab, origin, frameOrigin, username, password);
  });
}

export function rememberUsername(tab, origin, frameOrigin, username) {
  clearPending(tab);
  tab.pendingUsername = { origin, frameOrigin, username, timer: setTimeout(() => clearPending(tab), USERNAME_MS) };
}

/** A sign-in Butler typed from the input card: the same offer as a submitted page form. */
export function offerTyped(browser, tab, origin, username, password) {
  const pending = tab.pendingUsername;
  const name = username || (pending?.origin === origin && pending.frameOrigin === origin ? pending.username : "");
  return name && password ? offerSignIn(browser, tab, origin, undefined, name.slice(0, 256), password) : Promise.resolve();
}

// The Agent checks store availability and whether this exact sign-in is already saved.
function offerSignIn(browser, tab, origin, frameOrigin, username, password) {
  const check = (async () => {
    if (!await browser.signInOfferWanted?.({ origin, frame_origin: frameOrigin, username, password }).catch(() => false) || tab.closing || browser.tabs.get(tab.id) !== tab) return;
    clearOffer(tab);
    tab.saveOffer = { origin, username, password, timer: setTimeout(() => { clearOffer(tab); browser.publish(); }, OFFER_MS) };
    browser.publish();
  })().finally(() => { if (tab.offerCheck === check) tab.offerCheck = null; });
  tab.offerCheck = check;
  return check;
}

function clearPending(tab) {
  if (!tab?.pendingUsername) return;
  clearTimeout(tab.pendingUsername.timer);
  tab.pendingUsername = null;
}

export function clearOffer(tab) {
  clearPending(tab);
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

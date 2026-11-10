import { ipcMain } from "electron";
import { detectSource, evaluate, type, typePulled } from "./signin-fill.mjs";

export function installSignInFills(browser) {
  ipcMain.on("butler-browser:signin-field", async event => {
    const tab = [...browser.tabs.values()].find(item => item.view?.webContents === event.sender);
    const frame = event.senderFrame;
    if (!tab || !frame || tab.profile !== "signed_in" || tab.holder !== "user" || tab.saveOffer) return;
    const url = tab.view.webContents.getURL();
    const origin = new URL(url).origin;
    if (frame.origin !== origin || tab.fillDismissed === url || tab.fillOffer?.url === url) return;
    const accounts = await browser.signInAccounts?.(origin).catch(() => []);
    if (!accounts?.length || browser.tabs.get(tab.id) !== tab || tab.view.webContents.getURL() !== url) return;
    tab.fillOffer = { url, origin, accounts };
    browser.publish();
  });
}

export async function fillOffer(browser, id, entryId) {
  const tab = browser.tabs.get(id), offer = tab?.fillOffer;
  const unavailable = { ok: false, error: { code: "signin_fill_unavailable" } };
  if (!offer || tab.holder !== "user") return unavailable;
  const origin = new URL(tab.view.webContents.getURL()).origin;
  const account = offer.accounts.find(account => account.id === entryId);
  if (origin !== offer.origin || !account) return unavailable;
  const token = await browser.signInFillToken?.({ entry_id: entryId, origin });
  const state = await evaluate(tab, detectSource(tab.policy?.secure_keypads ?? []));
  if (!state.password) return unavailable;
  if (state.username) await type(tab, state.username, account.username, false);
  const typed = await typePulled(browser, tab, state.password, token, origin);
  if (typed === true) {
    tab.fillOffer = null;
    browser.publish();
    return { ok: true };
  }
  return { ok: false, error: { code: typed.reason ?? typed.status } };
}

export function dismissFill(browser, id) {
  const tab = browser.tabs.get(id);
  if (!tab) return;
  tab.fillDismissed = tab.fillOffer?.url;
  tab.fillOffer = null;
  browser.publish();
}

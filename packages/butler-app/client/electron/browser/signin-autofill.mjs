import { detectSource, evaluate, type, typePulled } from "./signin-fill.mjs";

export async function fillOffer(browser, id, entryId) {
  const tab = browser.tabs.get(id), offer = tab?.fillOffer;
  const unavailable = { ok: false, error: { code: "signin_fill_unavailable" } };
  if (!offer || tab.holder !== "user") return unavailable;
  const origin = new URL(tab.view.webContents.getURL()).origin;
  const account = offer.accounts.find(account => account.id === entryId);
  if (origin !== offer.origin || !account) return unavailable;
  const state = await evaluate(tab, detectSource(tab.policy?.secure_keypads ?? []));
  if (!state?.password) return unavailable;
  const token = await browser.signInFillToken?.({ entry_id: entryId, origin }).catch(() => undefined);
  if (!token) return unavailable;
  if (state.username) await type(tab, state.username, account.username, false);
  const typed = await typePulled(browser, tab, state.password, token, origin);
  if (typed === true) {
    tab.fillOffer = null;
    browser.publish();
    return { ok: true };
  }
  return { ok: false, error: { code: typed.reason ?? typed.status } };
}

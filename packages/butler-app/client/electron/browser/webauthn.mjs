import { webContents } from "electron";
import { beginDialog, resolveDialog } from "./dialogs.mjs";
import { shortId } from "./ids.mjs";

const listeners = new WeakMap();
/** Credentials stay in this callback closure; the owner sees opaque choices. */
export function wireWebAuthnAccounts(profile, browser) {
  const previous = listeners.get(profile);
  if (previous) profile.removeListener("select-webauthn-account", previous);
  const select = (_event, details, callback) => {
    const frame = details.frame;
    const contents = frame && !frame.isDestroyed() ? webContents.fromFrame(frame) : null;
    const tab = [...browser.tabs.values()].find(item => item.view?.webContents === contents);
    if (!tab || tab.dialog || !details.accounts.length || (tab.agent || tab.driven) && tab.holder !== "user") { callback(); return; }
    const choices = details.accounts.map(account => ({ id: shortId("a"), label: account.displayName || account.name, credentialId: account.credentialId }));
    const { processId, routingId } = frame;
    let answered = false;
    const cancel = (_event, _url, inPlace, mainFrame, navigatingProcessId, navigatingRoutingId) => {
      if (!inPlace && (mainFrame || navigatingProcessId === processId && navigatingRoutingId === routingId)) void resolveDialog(browser, tab, { accept: false }, "navigation");
    };
    contents.on("did-start-navigation", cancel);
    beginDialog(browser, tab, { type: "webauthn", origin: frame.url, accounts: choices.map(({ id, label }) => ({ id, label })) }, answer => {
      if (answered) return;
      answered = true;
      contents.removeListener("did-start-navigation", cancel);
      callback(answer.accept ? choices.find(choice => choice.id === answer.account)?.credentialId : undefined);
    });
  };
  listeners.set(profile, select);
  profile.on("select-webauthn-account", select);
}

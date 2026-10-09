import { stepStill } from "./stills.mjs";
import { randomUUID } from "node:crypto";
import { browserEvent } from "./events.mjs";

export const DIALOG_TIMEOUT_MS = 120_000;
export function publicDialog(tab) {
  const dialog = tab.dialog;
  if (!dialog) return null;
  const { id, epoch, type, message, defaultPrompt, origin, deadline, printers } = dialog;
  return { id, epoch, type, message, defaultPrompt, origin, deadline, printers, approvalRequired: (tab.agent || tab.driven) && tab.holder !== "user", untrusted: true };
}
export function beginDialog(browser, tab, value, callback) {
  if (tab.dialog) return;
  const dialog = { id: randomUUID(), epoch: tab.epoch, type: value.type, message: String(value.message ?? ""),
    defaultPrompt: String(value.defaultPrompt ?? ""), origin: value.url ?? value.origin ?? tab.url, deadline: Date.now() + DIALOG_TIMEOUT_MS,
    sessionId: value.sessionId, beforeUnloadClose: value.beforeUnloadClose, navigation: value.navigation, callback };
  tab.dialog = dialog; tab.waiting = true;
  dialog.timer = setTimeout(() => { void resolveDialog(browser, tab, { accept: false }, "timeout"); }, DIALOG_TIMEOUT_MS);
  browserEvent(browser, tab, "dialog_opened", { dialog: publicDialog(tab) });
  // The last completed still is available while the page's synchronous dialog is waiting.
  browser.publish(); browser.sync(tab);
}
export async function resolveDialog(browser, tab, answer, reason = "answered") {
  const dialog = tab.dialog;
  if (!dialog || dialog.answering) return;
  dialog.answering = true; clearTimeout(dialog.timer);
  if (dialog.callback) dialog.callback(answer);
  else if (!dialog.beforeUnloadClose && tab.view && !tab.view.webContents.isDestroyed()) {
    await tab.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: answer.accept === true, promptText: answer.value ?? "" }, dialog.sessionId).catch(() => {});
  }
  if (tab.dialog === dialog) tab.dialog = null;
  tab.waiting = false;
  browserEvent(browser, tab, answer.accept ? "dialog_accepted" : "dialog_cancelled", { dialog: dialog.id, dialog_type: dialog.type, reason });
  browser.publish(); browser.sync(tab);
}
/** Only agent/agent-driven tabs attach the debugger. */
export function wireDialogs(browser, tab) {
  if (tab.debugDialogs) return;
  tab.debugDialogs = true;
  const contents = tab.view.webContents;
  void contents.debugger.sendCommand("Page.enable").catch(() => {});
  contents.debugger.on("message", (_event, method, value, sessionId) => {
    if (method === "Page.javascriptDialogOpening") beginDialog(browser, tab, { ...value, beforeUnloadClose: value.type === "beforeunload" && tab.closeRequested, sessionId: sessionId || undefined });
    if (method === "Page.javascriptDialogClosed" && tab.dialog && !tab.dialog.answering && !tab.dialog.callback && !tab.dialog.beforeUnloadClose) {
      browserEvent(browser, tab, "dialog_cancelled", { dialog: tab.dialog.id, dialog_type: tab.dialog.type, reason: "page_closed" });
      clearTimeout(tab.dialog.timer); tab.dialog = null; tab.waiting = false; browser.publish(); browser.sync(tab);
    }
    if (method === "Page.fileChooserOpened") browserEvent(browser, tab, "file_chooser", { reason: "owner_required" });
  });
  void contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
}
export function pendingDialog(tab) {
  return { status: "dialog_pending", tab: tab.id, url: tab.url, epoch: tab.epoch, dialog: publicDialog(tab) };
}
export async function answerDialog(browser, tab, args) {
  if (!tab.dialog || tab.dialog.id !== args.dialog || tab.dialog.epoch !== tab.epoch) return { status: "not_dispatched", reason: "stale_dialog" };
  const close = tab.dialog.beforeUnloadClose;
  await resolveDialog(browser, tab, args);
  if (close && args.accept === true) { browser.close(tab.id); return { status: "ok", tab: tab.id }; }
  const steps = (tab.pendingBatch ?? []).map(step => step.reason === "dialog_pending" ? { ...step, status: "completed", reason: undefined } : step);
  const completed = steps.findLast(step => step.status === "completed");
  if (completed && tab.view && !tab.view.webContents.isDestroyed()) completed.still = await stepStill(tab);
  tab.pendingBatch = null;
  return { status: "ok", tab: tab.id, epoch: tab.epoch, url: tab.url, steps };
}
export function requestClose(browser, tab) {
  if (!tab) return Promise.resolve({ status: "ok" });
  if (tab.dialog) return Promise.resolve(pendingDialog(tab));
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed()) { browser.close(tab.id); return Promise.resolve({ status: "ok" }); }
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; tab.closeRequested = false; clearTimeout(timer);
      contents.removeListener("will-prevent-unload", prevented); contents.removeListener("destroyed", closed); resolve(result);
    };
    const prevented = () => {
      if (!tab.dialog) beginDialog(browser, tab, { type: "beforeunload", message: tab.title, beforeUnloadClose: true });
      else tab.dialog.beforeUnloadClose = true;
      finish(pendingDialog(tab));
    };
    const closed = () => { setImmediate(() => browser.close(tab.id)); finish({ status: "ok", tab: tab.id }); };
    const timer = setTimeout(() => finish({ status: "unknown", reason: "close_interrupted" }), 4500);
    contents.once("will-prevent-unload", prevented); contents.once("destroyed", closed);
    browser.detach(tab);
    tab.closeRequested = true;
    contents.close({ waitForBeforeUnload: true });
  });
}

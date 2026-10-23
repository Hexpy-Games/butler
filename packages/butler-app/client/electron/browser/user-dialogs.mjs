import { ipcMain } from "electron";
import { beginDialog, resolveDialog, publicDialog, unloadPreflight } from "./dialogs.mjs";
import { webUrl } from "./policy.mjs";
import { browserEvent } from "./events.mjs";
import { approvedUpload } from "./navigate.mjs";

const registries = new Map();
let installed = false;
export function wireUserDialogs(browser, tab) {
  const contents = tab.view.webContents;
  registries.set(contents.id, { browser, tab });
  if (!tab.agent) {
    // Electron's pinned dialog adapter keeps Chromium's beforeunload watchdog
    // paused while the owner answers. No native modal or dialog-specific CDP commands.
    contents.removeAllListeners("-run-dialog");
    contents.on("-run-dialog", (info, callback) => {
      const unload = tab.pageUnloadPrepared;
      tab.pageUnloadPrepared = false;
      if (tab.dialog) { callback(false, ""); return; }
      beginDialog(browser, tab, { type: unload ? "beforeunload" : info.dialogType, message: info.messageText,
        origin: info.frame?.url ?? contents.getURL(), defaultPrompt: info.defaultPromptText, pageBeforeUnload: unload }, answer => {
        if (unload) tab.pageUnloadHandled = true;
        callback(answer.accept === true, answer.value ?? "");
      });
    });
    contents.on("-cancel-dialogs", () => { if (tab.dialog?.pageBeforeUnload) void resolveDialog(browser, tab, { accept: false }, "page_closed"); });
  } else {
    // Electron's default handler opens a native message box parented to the
    // tab's window, which shows the hidden agent window. Agent tab dialogs stay
    // in the in-app flow: CDP reports them and this keeps Chromium's callback.
    contents.removeAllListeners("-run-dialog");
    contents.on("-run-dialog", (info, callback) => {
      const native = (accept, value) => { if (!contents.isDestroyed()) callback(accept === true, value ?? ""); };
      const open = tab.dialog;
      if (open && !open.answering && !open.callback && !open.native && open.type === info.dialogType && open.message === String(info.messageText ?? "")) { open.native = native; return; }
      if (open) { native(false, ""); return; }
      beginDialog(browser, tab, { type: info.dialogType, message: info.messageText, origin: info.frame?.url ?? contents.getURL(), defaultPrompt: info.defaultPromptText });
      if (tab.dialog) tab.dialog.native = native;
    });
    contents.on("-cancel-dialogs", () => { if (tab.dialog?.native) void resolveDialog(browser, tab, { accept: false }, "page_closed"); });
  }
  contents.on("input-event", (_event, input) => {
    if (["mouseDown", "keyDown"].includes(input.type)) { tab.popupGesture = true; tab.popupGestureAt = Date.now(); }
  });
  if (!installed) {
    installed = true;
    ipcMain.on("butler-browser:page-control", (event, input) => {
      const entry = registries.get(event.sender.id);
      if (!entry || !event.senderFrame || event.senderFrame.isDestroyed()) { event.returnValue = null; return; }
      const { browser: host, tab: source } = entry;
      const page = source.view.webContents;
      if (input?.type === "popup-finished") { source.programmaticPopup = false; event.returnValue = true; return; }
      if (input?.type === "popup" || input?.type === "gesture") {
        source.programmaticPopup = input.type === "popup";
        source.popupGesture = input.gesture === true; source.popupGestureAt = Date.now(); event.returnValue = true; return;
      }
      if (!["alert", "confirm", "prompt", "beforeunload", "print", "file"].includes(input?.type)) { event.returnValue = null; return; }
      if (input.type === "beforeunload") { source.pageUnloadPrepared = true; event.returnValue = true; return; }
      if (source.dialog) { event.returnValue = null; return; }
      if (input.type === "file" && source.pendingUpload) { event.returnValue = approvedUpload(source.pendingUpload); return; }
      if ((source.agent || source.driven) && source.holder !== "user" && ["print", "file"].includes(input.type)) {
        event.returnValue = null;
        browserEvent(host, source, input.type === "file" ? "file_chooser" : "print_requested", { reason: "owner_required" }); return;
      }
      beginDialog(host, source, { type: input.type, message: input.message, defaultPrompt: input.value, origin: event.senderFrame.url }, answer => {
        event.returnValue = input.type === "file" ? answer.accept ? answer.files : null : input.type === "prompt" ? answer.accept ? answer.value ?? "" : null : answer.accept;
        if (input.type === "print" && answer.accept && source.dialog?.printers?.some(printer => printer.name === answer.printer)) {
          page.print({ silent: true, deviceName: answer.printer }, success => browserEvent(host, source, "print_finished", { success }));
        }
      });
      if (input.type === "print") void page.getPrintersAsync().then(printers => {
        if (source.dialog?.type !== "print") return;
        source.dialog.printers = printers.map(printer => ({ name: printer.name, label: printer.displayName || printer.name })); host.publish(); host.sync(source);
      }).catch(() => {});
    });
  }
  contents.on("login", (event, details, auth, callback) => {
    event.preventDefault();
    if (auth.isProxy || tab.dialog || (tab.agent || tab.driven) && tab.holder !== "user") {
      callback(); browserEvent(browser, tab, "dialog_cancelled", { dialog_type: "auth", reason: "user_required" }); return;
    }
    beginDialog(browser, tab, { type: "auth", message: auth.realm, origin: details.url }, answer => {
      if (answer.accept) callback(answer.username ?? "", answer.password ?? ""); else callback();
    });
  });
  contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace && webUrl(url) && !tab.navigationIntent) tab.navigationIntent = { op: "navigate", value: url };
  });
  contents.on("did-navigate", () => { tab.navigationIntent = null; tab.unloadApproved = false; tab.pageUnloadHandled = false; });
  contents.on("will-prevent-unload", event => {
    if (tab.pageUnloadHandled) { tab.pageUnloadHandled = false; return; }
    if (tab.unloadApproved) { tab.unloadApproved = false; event.preventDefault(); return; }
    if (tab.dialog) return;
    beginDialog(browser, tab, { type: "beforeunload", message: tab.title, origin: contents.getURL(), navigation: tab.navigationIntent }, () => {});
  });
  contents.once("destroyed", () => { browser.detach(tab); tab.view = null; resolveDialog(browser, tab, { accept: false }, "tab_closed"); registries.delete(contents.id); if (!tab.closing) setImmediate(() => browser.close(tab.id)); });
}
export function answerUserDialog(browser, input) {
  const tab = browser.tabs.get(input.id);
  if (!tab?.dialog || tab.dialog.id !== input.dialog || tab.dialog.epoch !== tab.epoch) throw new Error("stale_dialog");
  if ((tab.agent || tab.driven) && tab.holder !== "user") throw new Error("owner_approval_required");
  if (input.accept && tab.dialog.type === "print" && !tab.dialog.printers?.some(printer => printer.name === input.printer)) throw new Error("invalid_printer");
  if (tab.dialog.pageBeforeUnload) return resolveDialog(browser, tab, input);
  if (input.accept && tab.dialog.type === "beforeunload") {
    const close = tab.dialog.beforeUnloadClose, navigation = tab.dialog.navigation;
    tab.unloadApproved = true;
    resolveDialog(browser, tab, input);
    if (close) browser.close(tab.id); else if (navigation) browser.commandTab(navigation.op, tab.id, navigation.value); else tab.view.webContents.reload();
    return;
  }
  return resolveDialog(browser, tab, input);
}
export function prepareUserNavigation(browser, tab, op, value) {
  // Empty or crashed views have no live document to run an unload preflight.
  if (tab.status === "crashed" || !tab.view.webContents.getURL()) { browser.commandTab(op, tab.id, value, true); return; }
  const epoch = tab.epoch;
  void unloadPreflight(tab.view.webContents).then(accept => {
    if (accept && browser.tabs.get(tab.id) === tab && tab.epoch === epoch) browser.commandTab(op, tab.id, value, true);
  });
}
export { publicDialog };

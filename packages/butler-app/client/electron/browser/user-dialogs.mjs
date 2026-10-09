import { ipcMain } from "electron";
import { beginDialog, resolveDialog, publicDialog } from "./dialogs.mjs";
import { webUrl } from "./policy.mjs";
import { browserEvent } from "./events.mjs";

const registries = new Map();
let installed = false;
export function wireUserDialogs(browser, tab) {
  const contents = tab.view.webContents;
  registries.set(contents.id, { browser, tab });
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
      if (input?.type === "popup" || input?.type === "gesture") {
        source.popupGesture = input.gesture === true; source.popupGestureAt = Date.now(); event.returnValue = true; return;
      }
      if (!["alert", "confirm", "prompt", "print", "file"].includes(input?.type)) { event.returnValue = null; return; }
      if (source.dialog) { event.returnValue = null; return; }
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
  contents.on("did-navigate", () => { tab.navigationIntent = null; tab.unloadApproved = false; });
  contents.on("will-prevent-unload", event => {
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
  if (input.accept && tab.dialog.type === "beforeunload") {
    const close = tab.dialog.beforeUnloadClose, navigation = tab.dialog.navigation;
    tab.unloadApproved = true;
    resolveDialog(browser, tab, input);
    if (close) browser.close(tab.id); else if (navigation) browser.commandTab(navigation.op, tab.id, navigation.value); else tab.view.webContents.reload();
    return;
  }
  return resolveDialog(browser, tab, input);
}
export { publicDialog };

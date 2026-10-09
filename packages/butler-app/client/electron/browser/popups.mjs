import { BrowserWindow, WebContentsView, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { popupWindowOptions, popupPlatform } from "../butler-platform/popup-window.mjs";
import { agentPopupAllowed } from "./popup-policy.mjs";
import { webUrl } from "./policy.mjs";
import { browserEvent } from "./events.mjs";
import { connectDebugger, backgroundTab } from "./agent.mjs";
import { publicDialog } from "./dialogs.mjs";
import { answerUserDialog } from "./user-dialogs.mjs";

const windows = new Map();
let installed = false;
function publishPopup(browser, tab) {
  const win = tab.popupWindow;
  if (!win || win.isDestroyed()) return;
  tab.popupChrome.webContents.send("butler-browser:popup-state", { id: tab.id, url: tab.url, parentTitle: browser.tabs.get(tab.opener)?.title,
    locale: tab.popupAppearance?.locale ?? "ko", theme: tab.popupAppearance?.theme ?? "light", platform: popupPlatform(), dialog: publicDialog(tab), still: tab.still });
}
export function syncPopup(browser, tab) {
  const win = tab.popupWindow;
  if (!win || win.isDestroyed() || !tab.view || tab.view.webContents.isDestroyed()) return;
  if (tab.covered || tab.dialog || !tab.bounds?.visible) {
    if (tab.attached === win) { win.contentView.removeChildView(tab.view); tab.attached = null; }
  } else {
    if (tab.attached !== win) { win.contentView.addChildView(tab.view); tab.attached = win; }
    const { x, y, width, height } = tab.bounds;
    tab.view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  }
  publishPopup(browser, tab);
}
function wireChrome(browser, tab, win) {
  const chrome = tab.popupChrome.webContents;
  windows.set(chrome.id, { browser, tab, win });
  if (!installed) {
    installed = true;
    ipcMain.handle("butler-browser:popup", (event, op, input = {}) => {
      const entry = windows.get(event.sender.id);
      if (!entry || event.senderFrame !== event.sender.mainFrame) throw new Error("popup_forbidden");
      if (op === "state") { publishPopup(entry.browser, entry.tab); return { id: entry.tab.id, url: entry.tab.url, platform: popupPlatform(), ...entry.tab.popupAppearance }; }
      if (op === "close") return entry.win.close();
      if (op === "dialog") return answerUserDialog(entry.browser, { ...input, id: entry.tab.id });
      if (op === "bounds" || op === "covered") return entry.browser.commandTab(op, entry.tab.id, input);
      throw new Error("invalid_popup_call");
    });
  }
  chrome.setWindowOpenHandler(() => ({ action: "deny" }));
  chrome.on("will-navigate", event => event.preventDefault());
  win.on("close", event => {
    if (tab.allowClose) return;
    event.preventDefault();
    tab.allowClose = true;
    void import("./dialogs.mjs").then(({ requestClose }) => requestClose(browser, tab)).then(result => { if (result.status === "dialog_pending") tab.allowClose = false; });
  });
  win.once("closed", () => { windows.delete(chrome.id); if (browser.tabs.has(tab.id)) browser.close(tab.id); });
  chrome.once("did-finish-load", () => { publishPopup(browser, tab); win.show(); tab.view?.webContents.focus(); });
}
function popupView(browser, source, details, options, agent) {
  const id = browser.create({ owner: source.owner, agent, policy: source.policy, partition: source.partition, profile: source.profile }, false);
  const tab = browser.tabs.get(id);
  tab.popupParentUrl = source.url; tab.opener = source.id; tab.popup = true;
  const preferences = browser.pagePreferences(tab);
  if (agent) {
    tab.view = new WebContentsView({ ...options, webPreferences: { ...options.webPreferences, ...preferences } });
    browser.materialize(tab); backgroundTab(browser, tab); connectDebugger(browser, tab);
    tab.url = webUrl(details.url) ?? ""; tab.popup = false;
  } else {
    tab.view = new WebContentsView({ ...options, webPreferences: { ...options.webPreferences, ...preferences } });
    const win = new BrowserWindow({ width: 520, height: 620, minWidth: 320, minHeight: 240, show: false,
      parent: browser.getWindow(), ...popupWindowOptions(), webPreferences: { sandbox: true, nodeIntegration: false,
        contextIsolation: true, preload: fileURLToPath(new URL("./popup-preload.cjs", import.meta.url)) } });
    win.center();
    tab.popupWindow = win; tab.popupChrome = { webContents: win.webContents };
    browser.materialize(tab); wireChrome(browser, tab, win);
    win.on("resize", () => syncPopup(browser, tab));
    void browser.getWindow()?.webContents.executeJavaScript("({locale:document.documentElement.lang,theme:document.querySelector('.theme-dark')?'dark':'light'})")
      .then(value => { tab.popupAppearance = value; publishPopup(browser, tab); });
    const shell = new URL(browser.getWindow().webContents.getURL()); shell.search = "popup=1"; shell.hash = "";
    void win.loadURL(shell.href);
  }
  source.blockedPopup = null;
  browserEvent(browser, source, "popup_opened", { popup: id, url: details.url }); browser.publish();
  return tab.view.webContents;
}
export function popupHandler(browser, source, details) {
  const agent = (source.agent || source.driven) && source.holder !== "user";
  const valid = webUrl(details.url) || details.url === "about:blank";
  const gesture = source.popupGesture === true && Date.now() - source.popupGestureAt < 5000;
  source.popupGesture = false;
  const site = source.url ? new URL(source.url).origin : "";
  const once = source.popupAllowance === site;
  const allowed = valid && (agent ? agentPopupAllowed(source.policy, source.url, details.url) : gesture || once);
  const peers = [...browser.tabs.values()].filter(tab => tab.owner === source.owner);
  const budget = browser.tabs.size < 36 && (agent ? peers.filter(tab => tab.agent || tab.driven).length < 3 && [...browser.tabs.values()].filter(tab => tab.agent || tab.driven).length < 6 : peers.length < 30);
  if (!allowed || !budget) {
    source.blockedPopup = { url: details.url, site, reason: budget ? agent ? "popup_policy" : "no_gesture" : "tab_budget_exhausted" };
    browserEvent(browser, source, "popup_blocked", source.blockedPopup); browser.publish(); return { action: "deny" };
  }
  if (once) source.popupAllowance = null;
  return { action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: { webPreferences: browser.pagePreferences({ ...source, agent }) }, createWindow: options => popupView(browser, source, details, options, agent) };
}
export function allowPopup(browser, id) {
  const tab = browser.tabs.get(id);
  if (!tab?.blockedPopup || (tab.agent || tab.driven) && tab.holder !== "user") throw new Error("popup_forbidden");
  const url = tab.blockedPopup.url;
  tab.popupAllowance = tab.blockedPopup.site;
  tab.blockedPopup = null; browser.publish();
  // Owner authorization opens a fresh child in the original opener. The previously denied WindowProxy cannot be recovered.
  void tab.view.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank')`).catch(() => {});
}
export function closePopups(browser, source) {
  for (const child of [...browser.tabs.values()]) if (child.opener === source.id) browser.close(child.id);
  if (source.popupWindow && !source.popupWindow.isDestroyed()) { source.allowClose = true; source.popupWindow.destroy(); }
}

import { installFrameLinks } from "./app-frame-links.mjs";
import { clipboard, ipcMain } from "electron";
import { openExternal } from "../desktop-shell.mjs";
import { defaultBrowserName } from "../butler-platform/default-browser.mjs";
import { menuPoint, popupMenu } from "../butler-platform/menu-placement.mjs";
import { webUrl } from "./policy.mjs";
import { nativeContextMenuCopy } from "../i18n/native-context-menu.mjs";

/** All App web links open a focused user-owned tab, including window.open. */
export async function openLink(browser, value, source) {
  const url = webUrl(value);
  if (!url || !browser) return false;
  await browser.open();
  const id = browser.create({ owner: source?.owner ?? "mine", url, ...(source ? { profile: source.profile, partition: source.partition, policy: source.policy } : {}) });
  browser.focusRequest = id;
  browser.publish();
  return true;
}

export function openExternalLink(value) {
  const url = webUrl(value);
  if (!url) return;
  return openExternal(url);
}

/** Explicit provider/account authentication ingress, separate from content links. */
export function openExternalSignIn(value) {
  return openExternalLink(value);
}

export async function linkMenuItems(browser, value, source) {
  const url = webUrl(value);
  if (!url) return [];
  const language = await browser.getLanguage();
  const copy = nativeContextMenuCopy(language);
  const name = defaultBrowserName(language);
  return [
    { label: source ? copy.openInNewTab : copy.openInButler, click: () => { void openLink(browser, url, source).catch(() => {}); } },
    { label: copy.openInBrowser(name), click: () => { void openExternalLink(url)?.catch(() => {}); } },
    { label: copy.copyLink, click: () => clipboard.writeText(url) },
    { type: "separator" },
  ];
}

/** Link-only ingress; it grants no App APIs to output/preview frames. */
export function installAppLinks(win, browser) {
  const menu = async (url, point, fromDom = false) => {
    const items = await linkMenuItems(browser, url);
    if (items.length && !win.isDestroyed()) await popupMenu(win, items.slice(0, -1), menuPoint(win.webContents, point, undefined, fromDom));
  };
  const receive = (event, op, url, point) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !webUrl(url)) return;
    if (op === "open") void openLink(browser, url).catch(() => {});
    if (op === "external") void openExternalLink(url)?.catch(() => {});
    if (op === "menu") void menu(url, point, true);
  };
  ipcMain.on("butler-app:link", receive);
  win.once("closed", () => ipcMain.removeListener("butler-app:link", receive));
  win.webContents.on("context-menu", (_event, params) => { if (params.linkURL) void menu(params.linkURL, params); });
  installFrameLinks(win.webContents);
}

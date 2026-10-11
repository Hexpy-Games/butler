import { installFrameLinks } from "./app-frame-links.mjs";
import { clipboard, ipcMain, shell } from "electron";
import { defaultBrowserName } from "../butler-platform/default-browser.mjs";
import { menuPoint, popupMenu } from "../butler-platform/menu-placement.mjs";
import { webUrl } from "./policy.mjs";

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
  return shell.openExternal(url);
}

export async function linkMenuItems(browser, value, source) {
  const url = webUrl(value);
  if (!url) return [];
  const win = browser.getWindow();
  const locale = await win?.webContents.executeJavaScript("document.documentElement.lang").catch(() => "en");
  const ko = locale?.startsWith("ko");
  const name = defaultBrowserName(locale);
  return [
    { label: source ? ko ? "새 탭에서 열기" : "Open in new tab" : ko ? "버틀러에서 열기" : "Open in Butler", click: () => { void openLink(browser, url, source).catch(() => {}); } },
    { label: ko ? `다음 브라우저로 열기: ${name}` : `Open in ${name}`, click: () => { void openExternalLink(url)?.catch(() => {}); } },
    { label: ko ? "링크 복사" : "Copy link", click: () => clipboard.writeText(url) },
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
    if (op === "menu") void menu(url, point, true);
  };
  ipcMain.on("butler-app:link", receive);
  win.once("closed", () => ipcMain.removeListener("butler-app:link", receive));
  win.webContents.on("context-menu", (_event, params) => { if (params.linkURL) void menu(params.linkURL, params); });
  installFrameLinks(win.webContents);
}

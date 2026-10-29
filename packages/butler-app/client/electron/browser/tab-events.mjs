import { session } from "electron";
import { menuPoint, popupMenu } from "../butler-platform/menu-placement.mjs";
import { webUrl } from "./policy.mjs";
import { nativeContextMenuCopy } from "../i18n/native-context-menu.mjs";

/** The icons a document lists, or its origin's default icon when it lists none. */
const DOCUMENT_ICONS = `(() => { const icons = [...document.querySelectorAll("link[rel~=icon]")].map((link) => link.href);
  return icons.length ? icons : /^https?:$/u.test(location.protocol) ? [location.origin + "/favicon.ico"] : []; })()`;

export function protectPartition(partition, browser) {
  const profile = session.fromPartition(partition);
  profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  profile.setPermissionCheckHandler(() => false);
  profile.setDevicePermissionHandler(() => false);
  profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  profile.on("will-download", (_event, item, contents) => {
    const tab = [...browser.tabs.values()].find(tab => tab.view?.webContents === contents);
    if (tab && tab.owner !== "mine") { browser.downloads.start(item, tab); return; }
    const release = browser.nativeCover();
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
    item.on("updated", () => { if (item.getSavePath()) release(); });
    item.once("done", release);
  });
}

export function wireTab(tab, actions) {
  const contents = tab.view.webContents;
  const update = () => actions.update(tab);
  // Hidden muted media must remain eligible to restart a loop. Idle user pages
  // return to Chromium's normal throttling when their media stops.
  contents.on("media-started-playing", () => contents.setBackgroundThrottling(false));
  contents.on("media-paused", () => { if (!tab.agent && !tab.driven) contents.setBackgroundThrottling(true); });
  for (const name of ["page-title-updated", "did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page"]) contents.on(name, update);
  contents.on("page-favicon-updated", (_event, urls) => { tab.favicon = urls.find((url) => webUrl(url)) ?? ""; tab.documentIcon = true; update(); });
  // page-favicon-updated reports only a changed icon list: a page with the same icons (a reload) sends
  // none, and so does an error page. Once a new document loads, the tab keeps its icon only if it lists it.
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) tab.documentIcon = false; });
  contents.on("did-stop-loading", () => {
    if (tab.documentIcon !== false) return;
    const keep = (icons) => {
      if (tab.documentIcon !== false) return;
      tab.documentIcon = true;
      if (!icons.includes(tab.favicon)) { tab.favicon = ""; update(); }
    };
    contents.executeJavaScript(DOCUMENT_ICONS).then(keep, () => keep([]));
  });
  contents.on("did-stop-loading", () => void actions.capture(tab));
  contents.on("render-process-gone", () => { tab.status = "crashed"; actions.detach(tab); actions.publish(); });
  for (const name of ["will-frame-navigate", "will-redirect"]) {
    contents.on(name, (event, url) => {
      const destination = typeof url === "string" ? url : event.url;
      if (!webUrl(destination)) event.preventDefault();
    });
  }
  contents.setWindowOpenHandler(details => actions.popup(tab, details));
  contents.on("input-event", (_event, input) => {
    if (input.type !== "mouseMove" && input.type !== "mouseEnter") return;
    const win = tab.attached;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const bounds = tab.view.getBounds();
    const point = Number.isFinite(input.x) && Number.isFinite(input.y)
      ? { x: bounds.x + input.x, y: bounds.y + input.y } : null;
    win.webContents.send("butler-browser:pointer", point);
  });
  contents.on("before-input-event", (event, input) => {
    if (actions.shortcut(input)) event.preventDefault();
  });
  contents.on("context-menu", async (_event, params) => {
    const win = tab.popupWindow ?? actions.window();
    const point = menuPoint(contents, params, tab.view.getBounds());
    const release = actions.nativeCover();
    await actions.capture(tab);
    actions.detach(tab);
    const copy = nativeContextMenuCopy(await actions.language());
    const template = [...await actions.linkMenu(params.linkURL),
      { role: "copy", label: copy.copy, enabled: Boolean(params.selectionText) },
      { role: "selectAll", label: copy.selectAll }];
    if (params.isEditable) template.unshift({ role: "paste", label: copy.paste });
    try { await popupMenu(win, template, point, release); }
    catch { release(); }
  });
}

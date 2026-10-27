import { nativeAppBounds } from "../text-size.mjs";
import { snapshotApp } from "./app-snapshot.mjs";
import { openExternalSignIn, openLink } from "./links.mjs";
import { requestClose } from "./dialogs.mjs";
import { answerUserDialog } from "./user-dialogs.mjs";
import { ipcMain, session } from "electron";
import { createUserBrowser } from "./tabs.mjs";
import { installQuitClose } from "./quit.mjs";
import { clearOffer, installSignInOffers, saveOffer } from "./signin-offer.mjs";
import { clearSiteData } from "./site-data.mjs";

/** "이 사이트 로그아웃": the site's cookies and storage leave the signed-in profile. */
async function signOutSite(site) {
  if (typeof site !== "string" || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/iu.test(site)) throw new Error("invalid_site");
  const profile = session.fromPartition("persist:butler-web");
  const cookies = await profile.cookies.get({ domain: site });
  await Promise.all(cookies.map(cookie => profile.cookies.remove(`http${cookie.secure ? "s" : ""}://${cookie.domain.replace(/^\./u, "")}${cookie.path}`, cookie.name)));
  for (const origin of [`https://${site}`, `https://www.${site}`, `http://${site}`]) await profile.clearStorageData({ origin });
  return { removed: cookies.length };
}

export function installUserBrowser(app, getWindow, getLanguage) {
  const browser = createUserBrowser(app, getWindow, getLanguage);
  installSignInOffers(browser);
  ipcMain.handle("butler-browser:call", (event, op, input = {}) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("browser_forbidden");
    switch (op) {
      case "pick": return browser.selection.mode(input.id, input.value);
      case "selection-command": return browser.selection.command(input.op, input.id);
      case "selection-snapshot": return browser.selection.snapshot(input.id, input.item);
      case "app-snapshot": return snapshotApp(win, input.target);
      case "open-link": return openLink(browser, input.url);
      case "open-external-signin": return openExternalSignIn(input.url);
      case "frame.subscribe": return browser.live.subscribe(input.id, event.sender, input.widthPx);
      case "frame.unsubscribe": return browser.live.unsubscribe(input.id);
      case "frame.visibility": return browser.live.visibility(input.value === true);
      case "state": return browser.snapshot();
      case "focus-app": return win.webContents.focus();
      case "open": return browser.open();
      case "hide": return browser.hide();
      case "presentation": return browser.pointer.present(input);
      case "scope": return browser.focusArea(input.value === true, input.owner);
      case "create": return browser.create(input);
      case "close": return requestClose(browser, browser.tabs.get(input.id));
      case "popup.show": {
        const popup = browser.tabs.get(input.id)?.popupWindow;
        if (!popup || popup.isDestroyed()) throw new Error("unknown_popup");
        popup.show(); popup.focus(); return;
      }
      case "popup.allow": return browser.allowPopup(input.id);
      case "dialog": return answerUserDialog(browser, input);
      case "activate": return browser.activate(input.id);
      case "control": return browser.control(input.id, input.holder, input.sticky === true);
      case "stills": return browser.setStills(input.id, input.value);
      case "move": return browser.move(input);
      case "save-signin": return saveOffer(browser, input.id);
      case "dismiss-signin": { clearOffer(browser.tabs.get(input.id)); browser.publish(); return; }
      case "signout": return signOutSite(input.site);
      case "clear-site-data": return clearSiteData(browser);
      default:
        if (!["navigate", "back", "forward", "reload", "stop", "bounds", "covered", "still", "focus"].includes(op)) throw new Error("invalid_browser_call");
        return browser.commandTab(op, input.id, op === "bounds" ? nativeAppBounds(event.sender, input.value, browser.tabs.get(input.id)?.agent === true) : input.value);
    }
  });
  ipcMain.on("butler-browser:selection-command", (event, op, id, point) => {
    if (event.sender !== browser.pointer.view?.webContents || event.senderFrame !== event.sender.mainFrame) return;
    browser.pointer.guard(() => {
      if (op === "drag" && Number.isFinite(point?.x) && Number.isFinite(point?.y) && id === browser.activeId) browser.selection.drag(browser.tabs.get(id), point, "start");
      if (["attach", "scrap", "clear", "finish", "save-image", "copy-text"].includes(op)) void browser.selection.command(op, id).catch(() => browser.getWindow()?.webContents.send("butler-browser:selection-action", { op: "failed", elements: [] }));
    });
  });
  ipcMain.on("butler-browser:selection-chrome", (event, id, rect) => {
    if (event.sender !== browser.pointer.view?.webContents || event.senderFrame !== event.sender.mainFrame || id !== browser.activeId) return;
    browser.selection.chrome = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ? rect : null;
  });
  installQuitClose(app, browser);
  return browser;
}

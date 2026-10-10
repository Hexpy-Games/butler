import { requestClose } from "./dialogs.mjs";
import { answerUserDialog } from "./user-dialogs.mjs";
import { ipcMain, session } from "electron";
import { createUserBrowser } from "./tabs.mjs";
import { clearOffer, installSignInOffers, saveOffer } from "./signin-offer.mjs";

/** "이 사이트 로그아웃": the site's cookies and storage leave the signed-in profile. */
async function signOutSite(site) {
  if (typeof site !== "string" || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/iu.test(site)) throw new Error("invalid_site");
  const profile = session.fromPartition("persist:butler-web");
  const cookies = await profile.cookies.get({ domain: site });
  await Promise.all(cookies.map(cookie => profile.cookies.remove(`http${cookie.secure ? "s" : ""}://${cookie.domain.replace(/^\./u, "")}${cookie.path}`, cookie.name)));
  for (const origin of [`https://${site}`, `https://www.${site}`, `http://${site}`]) await profile.clearStorageData({ origin });
  return { removed: cookies.length };
}

export function installUserBrowser(app, getWindow) {
  const browser = createUserBrowser(app, getWindow);
  installSignInOffers(browser);
  ipcMain.handle("butler-browser:call", (event, op, input = {}) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("browser_forbidden");
    switch (op) {
      case "pick": return browser.selection.mode(input.id, input.value);
      case "selection-command": return browser.selection.command(input.op, input.id);
      case "state": return browser.snapshot();
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
      default:
        if (!["navigate", "back", "forward", "reload", "stop", "bounds", "covered", "still", "focus"].includes(op)) throw new Error("invalid_browser_call");
        return browser.commandTab(op, input.id, input.value);
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
  let flushed = false;
  app.on("will-quit", (event) => {
    if (flushed) return;
    event.preventDefault();
    void browser.flush().catch(() => {}).then(() => browser.dispose()).finally(() => {
      flushed = true;
      // Electron ignores a same-tick quit after cancelling will-quit.
      setImmediate(() => app.quit());
    });
  });
  return browser;
}

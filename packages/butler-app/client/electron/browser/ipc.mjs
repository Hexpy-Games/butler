import { requestClose } from "./dialogs.mjs";
import { answerUserDialog } from "./user-dialogs.mjs";
import { ipcMain } from "electron";
import { createUserBrowser } from "./tabs.mjs";

export function installUserBrowser(app, getWindow) {
  const browser = createUserBrowser(app, getWindow);
  ipcMain.handle("butler-browser:call", (event, op, input = {}) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("browser_forbidden");
    switch (op) {
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
      default:
        if (!["navigate", "back", "forward", "reload", "stop", "bounds", "covered", "still", "focus"].includes(op)) throw new Error("invalid_browser_call");
        return browser.commandTab(op, input.id, input.value);
    }
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

import { ipcMain } from "electron";
import { createUserBrowser } from "./tabs.mjs";

export function installUserBrowser(app, getWindow) {
  const browser = createUserBrowser(app, getWindow);
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
      case "close": return browser.close(input.id);
      case "activate": return browser.activate(input.id);
      case "control": return browser.control(input.id, input.holder, input.sticky === true);
      case "stills": return browser.setStills(input.id, input.value);
      case "move": return browser.move(input);
      default:
        if (!["navigate", "back", "forward", "reload", "stop", "bounds", "covered", "still", "focus"].includes(op)) throw new Error("invalid_browser_call");
        return browser.commandTab(op, input.id, input.value);
    }
  });
  ipcMain.on("butler-browser:selection-command", (event, op, id, point) => {
    if (event.sender !== browser.pointer.view?.webContents || event.senderFrame !== event.sender.mainFrame) return;
    if (op === "drag" && Number.isFinite(point?.x) && Number.isFinite(point?.y) && id === browser.activeId) browser.selection.drag(browser.tabs.get(id), point, "start");
    if (["attach", "scrap", "clear", "finish"].includes(op)) browser.selection.command(op, id);
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

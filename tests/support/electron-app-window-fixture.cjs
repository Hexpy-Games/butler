// Fixture for the first-run window smokes, loaded with NODE_OPTIONS=--require into the Electron main process only.
// BUTLER_SMOKE_APP_WINDOW=occluded: the OS reports the shown App window occluded (a locked or fully covered macOS
// screen), where Electron emits no BrowserWindow "show" until the window is uncovered; every "show" event is dropped.
// BUTLER_SMOKE_APP_WINDOW=hidden:<ms>: the App window stays hidden (show() does nothing) until <ms> after the App
// first asks to show it, then shows for real.
const mode = process.env.BUTLER_SMOKE_APP_WINDOW ?? "";
if (process.versions.electron && process.type === "browser" && mode) {
  // The electron module resolves once Electron's own bootstrap has run.
  setImmediate(() => {
    const { app, BrowserWindow } = require("electron");
    const { emit, show } = BrowserWindow.prototype;
    if (mode === "occluded") {
      BrowserWindow.prototype.emit = function (name, ...args) {
        return name === "show" ? false : emit.call(this, name, ...args);
      };
      return;
    }
    const revealMs = Number(mode.slice("hidden:".length));
    let reveal = null;
    BrowserWindow.prototype.show = function () {
      if (!this.webContents.getURL().startsWith("app://butler/")) return show.call(this);
      // The reveal comes to the front, as a user opening the App would: a window behind others is occluded too.
      reveal ??= setTimeout(() => {
        reveal = true;
        if (this.isDestroyed()) return;
        app.focus({ steal: true });
        show.call(this);
        this.moveTop();
        this.focus();
      }, revealMs);
      if (reveal === true) show.call(this);
    };
  });
}

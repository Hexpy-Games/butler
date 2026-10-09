import { Menu, session } from "electron";
import { webUrl } from "./policy.mjs";

export function protectPartition(partition, nativeCover) {
  const profile = session.fromPartition(partition);
  profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  profile.setPermissionCheckHandler(() => false);
  profile.setDevicePermissionHandler(() => false);
  profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  profile.on("will-download", (_event, item) => {
    const release = nativeCover();
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
  contents.on("page-favicon-updated", (_event, urls) => { tab.favicon = urls.find((url) => webUrl(url)) ?? ""; update(); });
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
    const release = actions.nativeCover();
    await actions.capture(tab);
    actions.detach(tab);
    const template = [{ role: "copy", enabled: Boolean(params.selectionText) }, { role: "selectAll" }];
    if (params.isEditable) template.unshift({ role: "paste" });
    Menu.buildFromTemplate(template).popup({ window: actions.window(), callback: release });
  });
}

import { app } from "electron";
import { normalizeBrowserName } from "./browser-name.mjs";

let name;
function refresh() {
  try {
    name = ["darwin", "win32"].includes(process.platform)
      ? normalizeBrowserName(app.getApplicationNameForProtocol("https://")) : "";
  } catch { name = ""; }
}
app.on("browser-window-focus", refresh);
export function defaultBrowserName(locale) {
  if (name === undefined) refresh();
  return name || (locale?.startsWith("ko") ? "기본 브라우저" : "default browser");
}

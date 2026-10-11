import { app } from "electron";

let name;
function refresh() {
  try {
    name = ["darwin", "win32"].includes(process.platform)
      ? app.getApplicationNameForProtocol("https://").trim() : "";
  } catch { name = ""; }
}
app.on("browser-window-focus", refresh);
export function defaultBrowserName(locale) {
  if (name === undefined) refresh();
  return name || (locale?.startsWith("ko") ? "기본 브라우저" : "default browser");
}

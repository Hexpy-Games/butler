import { execFileSync } from "node:child_process";

/** Native menu pixels live in an OS overlay, outside webContents.capturePage. */
export function captureLinkMenu(bounds, path) {
  if (process.platform !== "darwin") throw new Error("native_menu_capture_unavailable");
  const region = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(",");
  execFileSync("/usr/sbin/screencapture", ["-x", "-r", "-T", "1", `-R${region}`, path]);
}

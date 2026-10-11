import { execFileSync } from "node:child_process";

/** Native menu pixels live in an OS overlay, outside webContents.capturePage. */
export function captureLinkMenu(bounds, path) {
  if (process.platform !== "darwin") throw new Error("native_menu_capture_unavailable");
  requireUnlockedDesktop();
  const region = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(",");
  execFileSync("/usr/sbin/screencapture", ["-x", "-r", "-T", "1", `-R${region}`, path]);
}

export function compileMenuInspector(dir) {
  if (process.platform !== "darwin") throw new Error("native_menu_geometry_unavailable");
  requireUnlockedDesktop();
  const path = `${dir}/menu-inspector`;
  execFileSync("/usr/bin/swiftc", [new URL("./link-menu-smoke-windows.swift", import.meta.url).pathname, "-o", path]);
  return path;
}

export function nativeMenuBounds(pid, inspector) {
  const menus = JSON.parse(execFileSync(inspector, [String(pid)], { encoding: "utf8" }));
  if (menus.length !== 1) throw new Error(`Expected one owned native menu; got ${menus.length}`);
  const { X: x, Y: y, Width: width, Height: height } = menus[0];
  return { x, y, width, height };
}

function requireUnlockedDesktop() {
  const session = execFileSync("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"], { encoding: "utf8" });
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/u.test(session)) throw new Error("native_menu_capture_unavailable: screen_locked");
}

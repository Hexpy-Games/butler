import { scaledWindowButtonPosition } from "./text-size.mjs";
/** Native titlebar differences stay inside the platform boundary. */
export function popupWindowOptions(platform = process.platform, factor = 1) {
  return platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: scaledWindowButtonPosition(factor, { x: 12, y: 13 }) } : { frame: false };
}
export function popupPlatform(platform = process.platform) { return platform; }

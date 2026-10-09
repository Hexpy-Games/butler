/** Native titlebar differences stay inside the platform boundary. */
export function popupWindowOptions(platform = process.platform) {
  return platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 13 } } : { frame: false };
}
export function popupPlatform(platform = process.platform) { return platform; }

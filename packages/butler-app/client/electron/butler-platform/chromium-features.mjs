// Desktop Chromium policy stays in the platform boundary, not UI styles.
export function configureChromiumFeatures(commandLine, platform = process.platform) {
  if (platform !== "win32" && platform !== "linux") return;
  const features = overlayFeatures(commandLine.getSwitchValue("enable-features"));
  commandLine.removeSwitch("enable-features");
  commandLine.appendSwitch("enable-features", features);
}

// Electron 44's default_app imports electron/main before the user's entry,
// caching NativeThemeAura's scrollbar policy before JS switches can take effect.
// Packaged Apps still configure the switch in bootstrap before nativeTheme loads.
export function chromiumLaunchArgs(args, platform = process.platform) {
  if (platform !== "win32" && platform !== "linux") return [...args];
  const prefix = "--enable-features=";
  const features = overlayFeatures(args.filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length)).join(","));
  return [prefix + features, ...args.filter((arg) => !arg.startsWith(prefix))];
}

function overlayFeatures(value) {
  const features = value.split(",").map((feature) => feature.trim()).filter(Boolean);
  if (!features.some((feature) => feature.split(/[<:]/, 1)[0] === "OverlayScrollbar")) {
    features.push("OverlayScrollbar");
  }
  return [...new Set(features)].join(",");
}

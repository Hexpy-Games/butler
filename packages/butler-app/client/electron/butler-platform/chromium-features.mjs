// Desktop Chromium policy stays in the platform boundary, not UI styles.
export function configureChromiumFeatures(commandLine, platform = process.platform) {
  if (platform !== "win32" && platform !== "linux") return;
  const features = commandLine.getSwitchValue("enable-features")
    .split(",").map((feature) => feature.trim()).filter(Boolean);
  if (!features.some((feature) => feature.split(/[<:]/, 1)[0] === "OverlayScrollbar")) {
    features.push("OverlayScrollbar");
  }
  commandLine.removeSwitch("enable-features");
  commandLine.appendSwitch("enable-features", [...new Set(features)].join(","));
}

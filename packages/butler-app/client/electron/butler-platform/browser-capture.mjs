/** Windows needs a live compositor while CDP re-renders a hidden page's clip.
 * Keep it painting only for this capture; return the original full-detail shot. */
export async function captureBrowserDetail(contents, params, platform = process.platform) {
  const hiddenHost = process.argv.some(arg => arg.startsWith("--butler-browser-host="));
  if (platform !== "win32" || !hiddenHost) {
    return contents.debugger.sendCommand("Page.captureScreenshot", params);
  }
  const acknowledge = (_event, method, value) => {
    if (method === "Page.screencastFrame") {
      void contents.debugger.sendCommand("Page.screencastFrameAck", { sessionId: value.sessionId }).catch(() => {});
    }
  };
  contents.debugger.on("message", acknowledge);
  try {
    await contents.debugger.sendCommand("Page.startScreencast", { format: "jpeg" });
    return await contents.debugger.sendCommand("Page.captureScreenshot", params);
  } finally {
    try { await contents.debugger.sendCommand("Page.stopScreencast"); }
    finally { contents.debugger.removeListener("message", acknowledge); }
  }
}

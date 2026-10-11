/** Output frames retain forms and scripts; only clicked web anchors leave them.
 * No IPC or App privilege is exposed to the frame.
 */
function captureLinks() {
  const open = window.open.bind(window);
  window.addEventListener("click", event => {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!link || !/^https?:/iu.test(link.href)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    open(link.href, "_blank", "noopener,noreferrer");
  }, true);
}

export function installFrameLinks(contents) {
  contents.on("frame-created", (_event, { frame }) => {
    if (!frame.parent) return;
    frame.on("dom-ready", () => {
      if (!frame.isDestroyed()) void frame.executeJavaScript(`(${captureLinks.toString()})()`).catch(() => {});
    });
  });
}

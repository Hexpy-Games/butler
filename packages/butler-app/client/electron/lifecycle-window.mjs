// Shared native lifecycle surface: static HTML, DS assets, no app preload/bundle.
import { readFileSync } from "node:fs";

const tokens = readFileSync(new URL("./assets/lifecycle-tokens.css", import.meta.url), "utf8");
const mark = readFileSync(new URL("./assets/lifecycle-mark.svg", import.meta.url), "utf8");
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function lifecycleWindowHtml(title, status) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<title>${escape(title)}</title><style>${tokens}
html,body { margin:var(--space-none); height:100%; background:var(--color-surface-base); color:var(--text-primary); }
body { display:flex; align-items:center; gap:var(--space-lg); padding:var(--space-2xl); box-sizing:border-box;
  font:var(--typo-body-weight) var(--typo-body-size)/var(--typo-body-line-height) var(--font-body); }
svg { width:var(--icon-size-2xl); height:var(--icon-size-2xl); flex-shrink:0; }
h1 { margin:var(--space-none); font-size:var(--typo-app-title-size); font-weight:var(--typo-app-title-weight); line-height:var(--typo-app-title-line-height); }
p { margin:var(--space-md) var(--space-none) var(--space-none); color:var(--text-secondary); }
</style></head><body>${mark}<div><h1>${escape(title)}</h1><p role="status" aria-live="polite">${escape(status)}</p></div></body></html>`;
}

export function createLifecycleWindow({ BrowserWindow, title, status }) {
  const window = new BrowserWindow({
    width: 380, height: 132, show: false, frame: false, resizable: false,
    minimizable: false, maximizable: false, closable: false, title,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  let loaded = false;
  let pending = status;
  let showing = false;
  const update = () => {
    if (!loaded || window.isDestroyed()) return;
    void window.webContents.executeJavaScript(`document.querySelector('[role=status]').textContent=${JSON.stringify(pending)};`).catch(() => {});
  };
  window.on("close", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(lifecycleWindowHtml(title, status))}`).then(() => {
    loaded = true;
    update();
    if (showing) window.show();
  });
  return {
    show() { showing = true; if (loaded) window.show(); },
    status(text) { pending = text; update(); },
    destroy() { if (!window.isDestroyed()) window.destroy(); },
  };
}

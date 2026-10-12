import { configureWebIdentity } from "./identity.mjs";
import { BrowserWindow, session } from "electron";
import { guardUrl } from "./guard.mjs";

// The reader's render step (web_read) in a hidden page: a fresh in-memory
// profile, no dialogs, permissions, popups or downloads, and every request
// behind the navigation guard (public http(s), or Butler's own outputs;
// data:/blob: subresources).
const MAX_HTML = 8 * 1024 * 1024;
const SETTLE = `new Promise(done=>{let timer;const end=()=>{observer.disconnect();clearTimeout(cap);done(true)};
  const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(end,500)});
  observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  timer=setTimeout(end,500);const cap=setTimeout(end,3000)})`;
const hosts = new Set();

export function closeReaderRenders() {
  for (const host of hosts) if (!host.isDestroyed()) host.destroy();
  hosts.clear();
}

function guard(contents, profile, policy, denied) {
  profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  profile.setPermissionCheckHandler(() => false);
  profile.on("will-download", event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  profile.webRequest.onBeforeRequest((details, callback) => {
    const frame = ["mainFrame", "subFrame"].includes(details.resourceType);
    if (!frame && /^(data|blob):/u.test(details.url)) { callback({}); return; }
    void guardUrl(details.url, profile, policy).then(allowed => {
      if (!allowed && frame) denied();
      callback({ cancel: !allowed });
    });
  });
}

export async function renderReader(args) {
  const wait = Math.min(Math.max(Number(args?.wait_ms) || 20_000, 1000), 20_000);
  if (typeof args?.url !== "string") return { status: "unknown", reason: "render_failed" };
  if (hosts.size >= 4) return { status: "unknown", reason: "browser_busy" };
  const profile = session.fromPartition(`butler-reader-${crypto.randomUUID()}`, { cache: false });
  // Public pages, and Butler's own outputs (policy.content_origin) as headless renders them.
  const policy = { content_origin: args.policy?.content_origin };
  if (!await guardUrl(args.url, profile, policy)) return { status: "navigation_denied" };
  const host = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: {
    session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, disableDialogs: true, webgl: false,
  } });
  hosts.add(host);
  const contents = host.webContents;
  let denied = false;
  let httpStatus = 200;
  guard(contents, profile, policy, () => { denied = true; });
  contents.on("did-navigate", (_event, _url, code) => { if (code > 0) httpStatus = code; });
  const timeout = setTimeout(() => { if (!host.isDestroyed()) host.destroy(); }, wait);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    await configureWebIdentity(contents);
    // Register before navigation: loadURL waits for all load-blocking resources,
    // while DOM readiness proves the complete document was parsed.
    await waitForDocument(contents, args.url);
    if (denied) return { status: "navigation_denied" };
    await contents.executeJavaScript(SETTLE).catch(() => {});
    const page = await contents.executeJavaScript("({url:location.href,html:document.documentElement.outerHTML})");
    if (denied || !await guardUrl(page.url, profile, policy)) return { status: "navigation_denied" };
    const html = Buffer.from(String(page.html), "utf8");
    if (html.length > MAX_HTML) return { status: "unknown", reason: "render_too_large" };
    return { status: "ok", final_url: page.url, http_status: httpStatus, html_base64: html.toString("base64") };
  } catch {
    return { status: denied ? "navigation_denied" : "unknown", reason: host.isDestroyed() ? "render_timeout" : "render_failed" };
  } finally {
    clearTimeout(timeout);
    hosts.delete(host);
    if (!host.isDestroyed()) host.destroy();
    void profile.clearStorageData().catch(() => {});
  }
}

// A script redirect aborts loadURL's first navigation, but the replacement
// document still emits dom-ready. Subframe failures do not fail the reader.
function waitForDocument(contents, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      contents.removeListener("dom-ready", ready);
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("did-fail-load", failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const destroyed = () => { cleanup(); reject(new Error("Reader destroyed")); };
    const failed = (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      cleanup(); reject(new Error(description));
    };
    contents.once("dom-ready", ready);
    contents.once("destroyed", destroyed);
    contents.on("did-fail-load", failed);
    void contents.loadURL(url).catch(error => {
      if (error.code === "ERR_ABORTED" || error.errno === -3) return;
      cleanup(); reject(error);
    });
  });
}

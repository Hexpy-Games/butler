import { BrowserWindow, session } from "electron";
import { checkScript } from "./page/check.mjs";

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const hosts = new Set();
const reports = new Map();
const MAX_DIAGNOSTICS = 1024;

export function closeOutputChecks() {
  for (const host of hosts) if (!host.isDestroyed()) host.destroy();
  hosts.clear();
  reports.clear();
}

function allowed(url, origin) {
  try { return new URL(url).origin === origin && new URL(url).pathname.startsWith("/__o/"); }
  catch { return false; }
}

function guard(contents, partition, origin, denied, rootAbsolute) {
  const navigate = (event, url) => {
    if (!allowed(event.url ?? url, origin)) { event.preventDefault(); denied(); }
  };
  for (const event of ["will-navigate", "will-frame-navigate", "will-redirect"]) contents.on(event, navigate);
  contents.setWindowOpenHandler(() => { denied(); return { action: "deny" }; });
  partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on("will-download", event => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => {
    const frame = ["mainFrame", "subFrame"].includes(details.resourceType);
    const cancel = frame ? !allowed(details.url, origin) :
      !(allowed(details.url, origin) || (details.url.startsWith("https:") && details.method === "GET") || /^(data|blob):/.test(details.url));
    if (cancel && frame) denied();
    if (!frame && details.url.startsWith(`${origin}/`) && !allowed(details.url, origin)) rootAbsolute();
    callback({ cancel });
  });
}

function diagnostics(contents, partition) {
  let total = 0;
  const shown = [];
  const add = message => {
    if (shown.length < MAX_DIAGNOSTICS) shown.push(compact(message));
    total++;
  };
  contents.on("console-message", (_event, details, message) => {
    const level = typeof details === "object" ? details.level : details;
    if (level === "error" || level === 3) add(typeof details === "object" ? details.message : message);
  });
  partition.webRequest.onErrorOccurred(details => add(`request: ${details.error} ${new URL(details.url).pathname}`));
  partition.webRequest.onCompleted(details => {
    if (details.statusCode >= 400) add(`request: HTTP ${details.statusCode} ${new URL(details.url).pathname}`);
  });
  return () => ({ total, shown: [...shown] });
}

async function emulate(contents, mobile) {
  const size = mobile ? MOBILE : DESKTOP;
  contents.enableDeviceEmulation({ screenPosition: mobile ? "mobile" : "desktop", screenSize: size,
    viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, viewSize: size, scale: 1 });
  // Electron has no native touch-emulation API. Only this gap uses the debugger.
  await contents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}
async function measure(contents, mobile) {
  await emulate(contents, mobile);
  return contents.executeJavaScriptInIsolatedWorld(999, [{ code: checkScript }]);
}

async function capture(contents) {
  const image = await contents.capturePage(undefined, { stayHidden: true });
  const size = image.getSize();
  const scale = Math.min(1, 1024 / Math.max(size.width, size.height));
  const resized = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
  for (const quality of [75, 50, 25]) {
    const jpeg = resized.toJPEG(quality);
    if (jpeg.length <= 150 * 1024) return { mime_type: "image/jpeg", data: jpeg.toString("base64") };
  }
  return { error: "image_too_large" };
}

export async function checkOutput(args, policy) {
  const origin = new URL(args.url).origin;
  if (policy?.kind !== "output_check" || policy.content_origin !== origin || !allowed(args.url, origin) || !origin.startsWith("http://127.0.0.1:")) return { status: "navigation_denied" };
  const key = `${args.output_id || args.url}:${args.revision || 0}`;
  if (args.cursor !== undefined) {
    const cached = reports.get(key);
    if (!cached || cached.expires < Date.now()) return { status: "unknown", reason: "cursor_expired" };
    if (args.include_image && (!cached.report.image || cached.viewport !== (args.viewport || "mobile"))) return { status: "unknown", reason: "image_unavailable" };
    return pageReport(cached.report, Number(args.cursor));
  }
  if (hosts.size >= 6) return { status: "unknown", reason: "browser_busy" };
  const partition = session.fromPartition(`butler-output-${crypto.randomUUID()}`, { cache: false });
  const host = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: {
    session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, disableDialogs: true, webgl: false,
  } });
  hosts.add(host);
  const contents = host.webContents;
  let denied = false;
  let rootAbsolute = false;
  guard(contents, partition, origin, () => { denied = true; }, () => { rootAbsolute = true; });
  const errors = diagnostics(contents, partition);
  const timeout = setTimeout(() => { if (!host.isDestroyed()) host.destroy(); }, 7500);
  try {
    contents.debugger.attach("1.3");
    await emulate(contents, false);
    const started = performance.now();
    await contents.loadURL(args.url);
    const load_ms = Math.round(performance.now() - started);
    const desktop = await measure(contents, false);
    const mobile = await measure(contents, true);
    if (denied || !allowed(contents.getURL(), origin)) return { status: "navigation_denied" };
    const report = { status: "ok", url: contents.getURL(), load_ms, title: compact(contents.getTitle()), errors: errors(),
      layout: { blank: desktop.blank && mobile.blank, overflow_px: { desktop: desktop.overflow, mobile: mobile.overflow } },
      warnings: [...new Set([...desktop.warnings, ...mobile.warnings, ...(rootAbsolute ? ["root_absolute_paths"] : [])])] };
    if (report.errors.total > MAX_DIAGNOSTICS) {
      return { status: "budget_exhausted", reason: "diagnostics_limit", errors: { total: report.errors.total, shown: report.errors.shown.slice(0, 5) } };
    }
    if (args.include_image) {
      if (args.viewport === "desktop") await measure(contents, false);
      report.image = await capture(contents);
    }
    if (reports.size >= 16) reports.delete(reports.keys().next().value);
    reports.set(key, { report, viewport: args.viewport || "mobile", expires: Date.now() + 600_000 });
    return pageReport(report, 0);
  } catch {
    return { status: denied ? "navigation_denied" : "unknown", reason: "check_failed" };
  } finally {
    clearTimeout(timeout);
    hosts.delete(host);
    if (!host.isDestroyed()) host.destroy();
  }
}

function pageReport(report, cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > report.errors.total) return { status: "unknown", reason: "cursor_invalid" };
  const result = { ...report, errors: { total: report.errors.total, shown: report.errors.shown.slice(cursor, cursor + 5) } };
  if (cursor + result.errors.shown.length < report.errors.total) result.next_cursor = cursor + result.errors.shown.length;
  return result;
}

function compact(value) {
  const text = String(value).slice(0, 100);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

import { webUrl } from "./policy.mjs";
import { devtoolsDom } from "./page/devtools-dom.mjs";
import { trackRequests } from "./guard.mjs";
import { credentialName } from "./credential-names.mjs";

/** DevTools capture for a conversation tab: console errors and request rows,
 * bounded, cleared when the main frame commits a new document. Cookies and
 * bodies are never kept; Rust decides what of the rest reaches the model. */
const MAX_CONSOLE = 200, MAX_NETWORK = 500, MAX_PENDING = 500, MAX_TEXT = 4000, MAX_HEADERS = 40, MAX_HEADER_VALUE = 500;
/** One reply stays well under the 256 KiB a host reply may be. */
const PAGE_SIZE = 100, PAGE_BYTES = 200 * 1024;

const hostOf = raw => { try { return new URL(raw).hostname.toLowerCase(); } catch { return ""; } };
const liveUrl = tab => (tab.view && !tab.view.webContents.isDestroyed() ? webUrl(tab.view.webContents.getURL()) : null);

export function watchDevtools(tab) {
  if (tab.devtools || !tab.view) return;
  const contents = tab.view.webContents;
  tab.devtools = { console: [], rows: [], pending: new Map(), droppedConsole: 0, droppedRows: 0, fromLoad: tab.agent === true };
  trackRequests(tab);
  // A same-site frame shares the main frame's process, and Electron reports it as that frame.
  contents.on("console-message", event => {
    if (event.level !== "error" || event.frame !== contents.mainFrame) return;
    const tools = tab.devtools;
    if (tools.console.length >= MAX_CONSOLE) { tools.console.shift(); tools.droppedConsole++; }
    tools.console.push({ level: "error", text: event.message.slice(0, MAX_TEXT), source: event.sourceId?.slice(0, MAX_TEXT), line: event.lineNumber });
  });
  contents.on("did-navigate", (_event, url) => {
    const tools = tab.devtools;
    tab.readsClosed = null;
    tools.console = []; tools.droppedConsole = 0; tools.droppedRows = 0; tools.fromLoad = true;
    // The new document's own request stays; what the old one still had going is not its data.
    const own = row => row.type === "mainFrame" && row.url === url.split("#")[0].slice(0, MAX_TEXT);
    tools.rows = tools.rows.filter(own);
    for (const [id, row] of tools.pending) if (!own(row)) tools.pending.delete(id);
  });
  // A sign-in that moves on within its document: what the page logged or sent
  // while the password sat in it stays unread, and capture starts again.
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    const movedFrom = tab.readsClosed?.inPage;
    if (!isMainFrame || !movedFrom || url === movedFrom) return;
    tab.readsClosed = null;
    Object.assign(tab.devtools, { console: [], rows: [], droppedConsole: 0, droppedRows: 0, fromLoad: false });
    tab.devtools.pending.clear();
  });
}

export function noteRequestStarted(tab, detail) {
  const tools = tab.devtools;
  if (!tools) return;
  if (tools.pending.size >= MAX_PENDING && !tools.pending.has(detail.id)) { tools.pending.delete(tools.pending.keys().next().value); tools.droppedRows++; }
  tools.pending.set(detail.id, { method: detail.method, url: detail.url.slice(0, MAX_TEXT), type: detail.resourceType, started: Date.now(), state: "pending" });
}
function failedHeaders(detail) {
  if (!(detail.statusCode >= 400)) return undefined;
  return Object.fromEntries(Object.entries(detail.responseHeaders ?? {})
    .filter(([name]) => !credentialName(name)).slice(0, MAX_HEADERS).map(([name, value]) => [name, [value].flat().join(", ").slice(0, MAX_HEADER_VALUE)]));
}
const headerValue = (detail, wanted) => {
  const entry = Object.entries(detail.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === wanted);
  return entry ? [entry[1]].flat() : [];
};
export function noteRequestFinished(tab, detail) {
  const tools = tab.devtools;
  if (!tools) return;
  const pending = tools.pending.get(detail.id);
  // Not in flight for this document: the old document's, whenever it ends.
  if (!pending) return;
  tools.pending.delete(detail.id);
  const bytes = Number(headerValue(detail, "content-length")[0]);
  if (tools.rows.length >= MAX_NETWORK) { tools.rows.shift(); tools.droppedRows++; }
  tools.rows.push({ method: detail.method, url: detail.url.slice(0, MAX_TEXT), type: detail.resourceType, status: detail.statusCode, error: detail.error && detail.error !== "net::OK" ? detail.error : undefined,
    cached: detail.fromCache, mime: headerValue(detail, "content-type")[0], bytes: Number.isFinite(bytes) ? bytes : undefined,
    ms: Date.now() - pending.started, response_headers: failedHeaders(detail) });
}

/** Whether a tab already shows a loopback page: the one reach a DevTools read has without driving the tab. */
export function onLocalPage(tab) {
  const url = liveUrl(tab);
  if (!url) return false;
  const host = hostOf(url).replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/u.test(host);
}

async function document(tab, args) {
  const code = `(${devtoolsDom.toString()})(${JSON.stringify({ selector: args.selector ?? null })})`;
  return tab.view.webContents.executeJavaScriptInIsolatedWorld(9001, [{ code }]);
}

const failed = row => row.status >= 400 || typeof row.error === "string";
/** One page of rows, newest last, as many as fit a reply, saying how many remain. */
function pageOf(all, args) {
  const rows = args.only_failed === true ? all.filter(failed) : all;
  const total = rows.length, end = total - Math.min(Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 0, total);
  let start = end, bytes = 0;
  while (start > 0 && end - start < PAGE_SIZE) {
    const size = Buffer.byteLength(JSON.stringify(rows[start - 1]));
    if (bytes + size > PAGE_BYTES) break;
    bytes += size; start--;
  }
  return { total, older: start, next_offset: start > 0 ? total - start : null, entries: rows.slice(start, end) };
}
function network(tab, args) {
  const tools = tab.devtools;
  const running = [...tools.pending.values()].map(({ started, ...row }) => ({ ...row, ms: Date.now() - started }));
  return { ...pageOf([...tools.rows, ...running], args), dropped: tools.droppedRows, from_load: tools.fromLoad };
}

const secretFilled = { status: "not_dispatched", reason: "secret_filled", recovery: "Butler filled a saved secret into this page. It can be read once the page changes." };

/** One read. The URL is read live, before and after, so a reply is never
 * reported against a page it did not come from. A document Butler filled a
 * saved secret into isn't read: its console, DOM and requests could repeat it. */
export async function devtoolsRead(tab, args) {
  if (!tab.view || tab.status === "crashed") return { status: "unknown", reason: "tab_crashed" };
  watchDevtools(tab);
  const before = liveUrl(tab);
  if (!before) return { status: "not_dispatched", reason: "navigation_denied" };
  if (tab.readsClosed) return secretFilled;
  let read;
  if (args.read === "console") read = { ...pageOf(tab.devtools.console, args), dropped: tab.devtools.droppedConsole, from_load: tab.devtools.fromLoad };
  else if (args.read === "network") read = network(tab, args);
  else if (args.read === "dom") read = await document(tab, args).catch(() => ({ unavailable: true }));
  else return { status: "not_dispatched", reason: "invalid_read" };
  if (tab.readsClosed) return secretFilled;
  if (read.unavailable) return { status: "unknown", reason: "frame_unavailable" };
  if (read.invalid_selector) return { status: "not_dispatched", reason: "invalid_selector" };
  if (liveUrl(tab) !== before || read.href && webUrl(read.href) !== before) return { status: "not_dispatched", reason: "devtools_page_changed", recovery: "The tab moved during this read. Call browser_devtools again." };
  return { ...read, status: "ok", tab: tab.id, url: before, read: args.read };
}

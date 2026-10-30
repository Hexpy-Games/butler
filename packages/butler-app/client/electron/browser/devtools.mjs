import { webUrl } from "./policy.mjs";
import { devtoolsDom } from "./page/devtools-dom.mjs";
import { trackRequests } from "./guard.mjs";

/** DevTools capture for a conversation tab: console errors and request rows,
 * bounded, cleared when the main frame commits a new document. Cookies and
 * bodies are never kept; Rust decides what of the rest reaches the model. */
const MAX_CONSOLE = 200, MAX_NETWORK = 500, MAX_HOSTS = 256, MAX_TEXT = 4000, MAX_HEADERS = 40, MAX_HEADER_VALUE = 500;
/** One reply stays well under the 256 KiB a host reply may be. */
const PAGE_SIZE = 100, PAGE_BYTES = 200 * 1024;
const CREDENTIAL_HEADER = /cookie|authorization|auth|token|secret|session|csrf|xsrf|api-?key|credential|signature/iu;
const seen = new WeakMap();

export const DEVTOOLS_OPS = new Set(["tab.devtools_place", "tab.devtools"]);
const hostOf = raw => { try { return new URL(raw).hostname.toLowerCase(); } catch { return ""; } };

/** Credentials this profile's traffic showed, by host. A partition holds them for all its tabs. */
function credentialedHosts(session) {
  let hosts = seen.get(session);
  if (!hosts) { hosts = new Set(); seen.set(session, hosts); }
  return hosts;
}
function noteCredential(tab, url) {
  const hosts = credentialedHosts(tab.session);
  for (const host of [hostOf(url), hostOf(tab.url)]) if (host && hosts.size < MAX_HOSTS) hosts.add(host);
}

export function watchDevtools(tab) {
  if (tab.devtools || !tab.view) return;
  const contents = tab.view.webContents;
  tab.devtools = { console: [], rows: [], pending: new Map(), droppedConsole: 0, droppedRows: 0, fromLoad: tab.agent === true };
  trackRequests(tab);
  contents.on("console-message", event => {
    if (event.level !== "error") return;
    const tools = tab.devtools;
    if (tools.console.length >= MAX_CONSOLE) { tools.console.shift(); tools.droppedConsole++; }
    tools.console.push({ level: "error", text: event.message.slice(0, MAX_TEXT), source: event.sourceId?.slice(0, MAX_TEXT), line: event.lineNumber });
  });
  contents.on("did-navigate", (_event, url) => {
    const tools = tab.devtools;
    tools.console = []; tools.droppedConsole = 0; tools.droppedRows = 0; tools.fromLoad = true;
    tools.rows = tools.rows.filter(row => row.type === "mainFrame" && row.url === url.slice(0, MAX_TEXT));
  });
}

export function noteRequestStarted(tab, detail) {
  tab.devtools?.pending.set(detail.id, { method: detail.method, url: detail.url.slice(0, MAX_TEXT), type: detail.resourceType, started: Date.now(), state: "pending" });
}
export function noteRequestSent(tab, detail) {
  if (!tab.devtools) return;
  if (Object.keys(detail.requestHeaders ?? {}).some(name => name.toLowerCase() === "authorization")) noteCredential(tab, detail.url);
}
function failedHeaders(tab, detail) {
  if (tab.profile === "signed_in" || !(detail.statusCode >= 400)) return undefined;
  return Object.fromEntries(Object.entries(detail.responseHeaders ?? {})
    .filter(([name]) => !CREDENTIAL_HEADER.test(name)).slice(0, MAX_HEADERS).map(([name, value]) => [name, [value].flat().join(", ").slice(0, MAX_HEADER_VALUE)]));
}
const headerValue = (detail, wanted) => {
  const entry = Object.entries(detail.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === wanted);
  return entry ? [entry[1]].flat() : [];
};
export function noteRequestFinished(tab, detail) {
  const tools = tab.devtools;
  if (!tools) return;
  const pending = tools.pending.get(detail.id);
  tools.pending.delete(detail.id);
  if (detail.method !== "GET" && detail.method !== "HEAD" && headerValue(detail, "set-cookie").some(line => /httponly/iu.test(line))) noteCredential(tab, detail.url);
  const bytes = Number(headerValue(detail, "content-length")[0]);
  if (tools.rows.length >= MAX_NETWORK) { tools.rows.shift(); tools.droppedRows++; }
  tools.rows.push({ method: detail.method, url: detail.url.slice(0, MAX_TEXT), type: detail.resourceType, status: detail.statusCode, error: detail.error && detail.error !== "net::OK" ? detail.error : undefined,
    cached: detail.fromCache, mime: headerValue(detail, "content-type")[0], bytes: Number.isFinite(bytes) ? bytes : undefined,
    ms: pending ? Date.now() - pending.started : undefined, response_headers: failedHeaders(tab, detail) });
}

const liveUrl = tab => webUrl(tab.view?.webContents.getURL() ?? "");

function standing(tab) {
  return { status: "ok", tab: tab.id, url: liveUrl(tab), profile: tab.profile, credentialed_hosts: [...credentialedHosts(tab.session)] };
}

/** Whether a tab already shows a loopback page: the one reach DevTools reads have without driving the tab. */
export function onLocalPage(tab) {
  const url = liveUrl(tab);
  if (!url) return false;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\./u.test(host);
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

/** The place op and the read. The URL is read live, before and after, so a
 * reply is never reported against a page it did not come from. */
export async function devtoolsCall(tab, op, args) {
  if (!tab.view || tab.status === "crashed") return { status: "unknown", reason: "tab_crashed" };
  watchDevtools(tab);
  const before = standing(tab);
  if (!before.url) return { status: "not_dispatched", reason: "navigation_denied" };
  if (op === "tab.devtools_place") return before;
  let read;
  if (args.read === "console") read = { ...pageOf(tab.devtools.console, args), dropped: tab.devtools.droppedConsole, from_load: tab.devtools.fromLoad };
  else if (args.read === "network") read = network(tab, args);
  else if (args.read === "dom") read = await document(tab, args).catch(() => ({ unavailable: true }));
  else return { status: "not_dispatched", reason: "invalid_read" };
  if (read.unavailable) return { status: "unknown", reason: "frame_unavailable" };
  if (read.invalid_selector) return { status: "not_dispatched", reason: "invalid_selector" };
  if (liveUrl(tab) !== before.url) return { status: "not_dispatched", reason: "devtools_page_changed", recovery: "The tab moved during this read. Call browser_devtools again." };
  return { ...read, ...standing(tab), read: args.read };
}

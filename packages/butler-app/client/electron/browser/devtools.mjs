import { webUrl } from "./policy.mjs";
import { devtoolsDom, devtoolsSelectorValid } from "./page/devtools-dom.mjs";
import { trackRequests } from "./guard.mjs";
import { credentialHeader, credentialName, loginCookie, passwordField } from "./credential-names.mjs";

/** DevTools capture for a conversation tab: console errors and request rows,
 * bounded, cleared when the main frame commits a new document. Cookies and
 * bodies are never kept; Rust decides what of the rest reaches the model. */
const MAX_CONSOLE = 200, MAX_NETWORK = 500, MAX_PENDING = 500, MAX_HOSTS = 64, MAX_TEXT = 4000, MAX_HEADERS = 40, MAX_HEADER_VALUE = 500;
/** One reply stays well under the 256 KiB a host reply may be. */
const PAGE_SIZE = 100, PAGE_BYTES = 200 * 1024;
const seen = new WeakMap();

export const DEVTOOLS_OPS = new Set(["tab.devtools_place", "tab.devtools"]);
const hostOf = raw => { try { return new URL(raw).hostname.toLowerCase(); } catch { return ""; } };

/** Evidence this profile's traffic and users showed, by host. A partition holds it for all its tabs. */
function evidence(session) {
  let found = seen.get(session);
  if (!found) { found = { hosts: new Set(), overflow: false }; seen.set(session, found); }
  return found;
}
function noteCredential(tab, ...urls) {
  if (!tab.session) return;
  const found = evidence(tab.session);
  for (const host of urls.map(hostOf)) {
    if (!host) continue;
    if (found.hosts.size < MAX_HOSTS) found.hosts.add(host); else found.overflow = true;
  }
}
const liveUrl = tab => (tab.view && !tab.view.webContents.isDestroyed() ? webUrl(tab.view.webContents.getURL()) : null);
function isLocalHost(raw) {
  const host = raw.toLowerCase().replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/u.test(host);
}
const isLocal = url => isLocalHost(hostOf(url));
const originOf = raw => { try { return new URL(raw).origin; } catch { return ""; } };
/** Whatever the user did on this site may have signed them in. A loopback page stays as it was. */
export function noteUserHold(tab) {
  const url = liveUrl(tab);
  if (url && !isLocal(url)) noteCredential(tab, url);
}

/** A password going into a field by Butler's own hand is a sign-in in progress, whatever the site keeps afterwards. */
export function notePasswordEntry(tab, hit) {
  if (passwordField(hit?.name)) noteCredential(tab, liveUrl(tab) ?? tab.url);
}

/** How the tab reached its page. Only a navigation the browser started (the
 * address bar, a bookmark, Butler opening a tab) can make a loopback page the
 * user's own; one a page started keeps what the page before it had, and only
 * on the same origin. Asked of each navigation, so one that came to nothing (a
 * 204, a download) leaves no mark on the next. */
export function watchArrival(tab) {
  if (tab.arrival || !tab.view) return;
  const contents = tab.view.webContents;
  // A page-opened tab's first page is the page's doing, and may start before this listens.
  tab.arrival = { opened: Boolean(tab.opener || tab.pageOpened), byPage: false, start: "", url: "", trusted: false };
  contents.on("did-start-navigation", details => {
    if (!details.isMainFrame || details.isSameDocument) return;
    tab.arrival.start = details.url; tab.arrival.byPage = Boolean(details.initiator);
  });
  // Fires only for a navigation the renderer started, after the one above: holds when an initiator is gone.
  contents.on("will-navigate", () => { tab.arrival.byPage = true; });
  contents.on("did-navigate", (_event, url) => {
    const { opened, byPage, start, url: before, trusted } = tab.arrival;
    const sameOrigin = originOf(url) === originOf(before);
    const inherits = (opened || byPage) ? trusted && sameOrigin : url === before ? trusted : true;
    tab.arrival.trusted = isLocal(url) && (!start || isLocal(start)) && inherits;
    tab.arrival.opened = false; tab.arrival.url = url;
  });
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
    // The new document's own request stays; what the old one still had going is not its data.
    const own = row => row.type === "mainFrame" && row.url === url.split("#")[0].slice(0, MAX_TEXT);
    tools.rows = tools.rows.filter(own);
    for (const [id, row] of tools.pending) if (!own(row)) tools.pending.delete(id);
    if (tab.holder === "user") noteUserHold(tab);
  });
  contents.on("did-navigate-in-page", () => { if (tab.holder === "user") noteUserHold(tab); });
}

export function noteRequestStarted(tab, detail) {
  const tools = tab.devtools;
  if (!tools) return;
  if (tools.pending.size >= MAX_PENDING && !tools.pending.has(detail.id)) { tools.pending.delete(tools.pending.keys().next().value); tools.droppedRows++; }
  tools.pending.set(detail.id, { method: detail.method, url: detail.url.slice(0, MAX_TEXT), type: detail.resourceType, started: Date.now(), state: "pending" });
}
export function noteRequestSent(tab, detail) {
  if (!tab.devtools) return;
  if (Object.keys(detail.requestHeaders ?? {}).some(credentialHeader)) noteCredential(tab, detail.url, tab.url);
}
function failedHeaders(tab, detail) {
  if (tab.profile === "signed_in" || !(detail.statusCode >= 400)) return undefined;
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
    ms: Date.now() - pending.started, response_headers: failedHeaders(tab, detail) });
}

/** Where the tab is now, decided at this moment from the live page and the
 * cookie store. The cookies stay here: only their hosts leave. */
async function standing(tab) {
  const found = evidence(tab.session);
  const hosts = new Set(found.hosts);
  let overflow = found.overflow;
  if (tab.profile !== "signed_in") {
    try {
      for (const cookie of await tab.session.cookies.get({})) {
        const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
        if (loginCookie(cookie.name, cookie.httpOnly, domain, isLocalHost)) hosts.add(domain);
      }
    } catch { overflow = true; }
  }
  if (hosts.size > MAX_HOSTS) overflow = true;
  return { status: "ok", tab: tab.id, url: liveUrl(tab), profile: tab.profile, credentialed_hosts: [...hosts].slice(0, MAX_HOSTS), credentials_overflow: overflow, local_trusted: tab.arrival?.trusted === true };
}

/** Whether a tab already shows a loopback page: the one reach DevTools reads have without driving the tab. */
export function onLocalPage(tab) {
  const url = liveUrl(tab);
  return Boolean(url) && isLocal(url);
}

async function selectorValid(tab, selector) {
  const code = `(${devtoolsSelectorValid.toString()})(${JSON.stringify(selector)})`;
  return tab.view.webContents.executeJavaScriptInIsolatedWorld(9001, [{ code }]).catch(() => false);
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
  const before = liveUrl(tab);
  if (!before) return { status: "not_dispatched", reason: "navigation_denied" };
  if (op === "tab.devtools_place") {
    if (typeof args.selector === "string" && !await selectorValid(tab, args.selector)) return { status: "not_dispatched", reason: "invalid_selector" };
    return standing(tab);
  }
  let read;
  if (args.read === "console") read = { ...pageOf(tab.devtools.console, args), dropped: tab.devtools.droppedConsole, from_load: tab.devtools.fromLoad };
  else if (args.read === "network") read = network(tab, args);
  else if (args.read === "dom") read = await document(tab, args).catch(() => ({ unavailable: true }));
  else return { status: "not_dispatched", reason: "invalid_read" };
  if (read.unavailable) return { status: "unknown", reason: "frame_unavailable" };
  if (read.invalid_selector) return { status: "not_dispatched", reason: "invalid_selector" };
  const after = await standing(tab);
  if (after.url !== before || read.href && webUrl(read.href) !== before) return { status: "not_dispatched", reason: "devtools_page_changed", recovery: "The tab moved during this read. Call browser_devtools again." };
  return { ...read, ...after, read: args.read };
}

// The real App capture code in real Electron against a local server: what crosses
// a navigation, how far a reply goes, and a document Butler filled a secret into.
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const out = {};
const save = () => writeFileSync(process.env.DEVTOOLS_CAPTURE_OUT, JSON.stringify(out, null, 1));
const fail = error => { console.error(String(error?.stack ?? error)); save(); app.exit(3); };
const hardStop = setTimeout(() => fail("hard stop"), 90_000);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (win, code) => win.webContents.executeJavaScript(code);
const page = body => `<!doctype html><meta charset="utf-8"><title>t</title>${body}`;

async function main() {
  app.dock?.hide();
  const dir = process.env.DEVTOOLS_BROWSER_DIR;
  const { watchDevtools, devtoolsRead } = await import(`${dir}/devtools.mjs`);
  // A page that sends what is typed into it, as a strength meter or a card lookup does.
  const echo = `<script>addEventListener("input", event => { void fetch("/strength?value=" + encodeURIComponent(event.target.value)); })</script>`;
  const asked = [];
  let port;
  const server = createServer((req, res) => {
    asked.push(req.url);
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("Content-Type", "text/html");
    if (path === "/hang") return undefined;
    if (path === "/with-fetch") return res.end(page("<script>fetch('/sub')</script>"));
    if (path === "/fields") return res.end(page(`<input name="cardNumber" value="4242"><p>${"\u0001".repeat(400)}</p>`.repeat(300)));
    if (path === "/signin") return res.end(page(`<form onsubmit="return false"><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"></form><script>console.error("sign-in page")</script>${echo}`));
    if (path === "/pay") return res.end(page(`<form onsubmit="return false"><input name="cardNumber" autocomplete="cc-number" aria-label="Card number"><input name="exp" autocomplete="cc-exp" aria-label="Expiry"><input name="cvc" autocomplete="cc-csc" aria-label="CVC"></form><script>console.error("pay page")</script>${echo}`));
    if (path === "/framed") return res.end(page(`<script>console.error("MAIN_FRAME")</script><iframe src="http://localhost:${port}/framelog"></iframe>`));
    if (path === "/framelog") return res.end(page(`<script>console.error("SUB_FRAME")</script>`));
    res.writeHead(200); return res.end(page("<p>page</p>"));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let partition = 0;
  async function makeTab(start = base) {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: `capture-${partition++}`, sandbox: true, contextIsolation: true } });
    const tab = { id: `t${partition}`, view: win, session: win.webContents.session, url: start, profile: "signed_out", agent: true, status: "idle" };
    watchDevtools(tab);
    await win.loadURL(start);
    return { win, tab };
  }
  const close = async win => { win.destroy(); await settle(100); };

  // What crosses a navigation, and whether the new document's own requests stay.
  {
    const { win, tab } = await makeTab();
    void js(win, "fetch('/hang?from=OLD_DOCUMENT').catch(()=>{});0").catch(() => {});
    await settle(200);
    await win.loadURL(`http://localhost:${port}/with-fetch`).catch(() => {});
    await settle(300);
    const read = await devtoolsRead(tab, { read: "network" });
    out.crossing = { status: read.status, rows: read.entries?.map(row => row.url) };
    await close(win);
  }

  // Requests that never finish stay bounded.
  {
    const { win, tab } = await makeTab();
    void js(win, "for(let i=0;i<800;i++)fetch('/hang?i='+i).catch(()=>{});0").catch(() => {});
    await settle(800);
    const read = await devtoolsRead(tab, { read: "network" });
    out.pending = { total: read.total, dropped: read.dropped, bytes: Buffer.byteLength(JSON.stringify(read)) };
    await close(win);
  }

  // A DOM reply stays inside a host reply, even when JSON expands the text; it says where it stands.
  {
    const { win, tab } = await makeTab(`${base}/fields`);
    const read = await devtoolsRead(tab, { read: "dom" });
    out.dom = { status: read.status, bytes: Buffer.byteLength(JSON.stringify(read)), walked_all: read.walked_all, href: read.href, url: read.url };
    out.selector = await devtoolsRead(tab, { read: "dom", selector: "[[" });
    await close(win);
  }

  // Another site's frame: its console is not the page's.
  {
    const { win, tab } = await makeTab(`${base}/framed`);
    await settle(400);
    const read = await devtoolsRead(tab, { read: "console" });
    out.frames = { texts: read.entries?.map(row => row.text), loaded: asked.includes("/framelog") };
    await close(win);
  }

  // A document Butler filled a secret into: the real fills, through the real browser.
  {
    const { createUserBrowser } = await import(`${dir}/tabs.mjs`);
    const { executeBrowser } = await import(`${dir}/agent.mjs`);
    const shell = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await shell.loadURL(`${base}/shell`);
    const browser = createUserBrowser(app, () => shell, async () => "en");
    browser.pullCredential = async () => ({ password: "SECRET-PASSWORD" });
    browser.pullVault = async () => ({ values: { number: "4242424242424242", cvc: "123", exp_month: "12", exp_year: "2030", name: "A", expiry: "12/30" } });
    const session = "capture";
    const policy = { mode: "signed_in", sites: ["127.0.0.1"], content_origin: base, preview: true };
    const call = (op, tab, args = {}) => executeBrowser(browser, { op, session, tab, args: { policy, ...args }, deadline_ms: 20_000 });
    const fills = {
      "sign-in": { path: "/signin", op: "signin.fill", args: { username: "someone", fill_token: "t", origins: [base] } },
      card: { path: "/pay", op: "pay.fill", args: { kind: "card", fill_token: "t", top_origin: base, frame_origins: [] } },
    };
    const secret = /SECRET-PASSWORD|4242424242424242/u;
    const reasons = async id => Object.fromEntries(await Promise.all(["console", "dom", "network"].map(async read => [read, (await call("tab.devtools", id, { read })).reason ?? "ok"])));
    const rowsOf = async id => (await call("tab.devtools", id, { read: "network" })).entries?.map(row => row.url) ?? [];
    const moveWithin = async (tab, script) => { await tab.view.webContents.executeJavaScript(script); await settle(150); };
    const openFilled = async ({ path, op, args }, type = text => text) => {
      const opened = await call("tab.open", undefined, { url: `${base}${path}`, signed_in: true });
      const tab = browser.tabs.get(opened.tab), contents = tab.view.webContents, real = contents.insertText.bind(contents);
      const state = { closedWhenTyped: null };
      contents.insertText = async text => {
        if (secret.test(text)) state.closedWhenTyped = Boolean(tab.readsClosed);
        return real(type(text));
      };
      state.filled = await call(op, opened.tab, args).catch(error => ({ status: "threw", reason: String(error) }));
      await settle(300);
      return { id: opened.tab, tab, state };
    };

    out.fills = {};
    for (const [name, fill] of Object.entries(fills)) {
      const opened = await call("tab.open", undefined, { url: `${base}${fill.path}`, signed_in: true });
      const before = { console: (await call("tab.devtools", opened.tab, { read: "console" })).status, dom: (await call("tab.devtools", opened.tab, { read: "dom" })).status };
      browser.close(opened.tab);
      await settle(100);
      asked.length = 0;
      const { id, tab, state } = await openFilled(fill);
      const refused = await reasons(id);
      await tab.view.webContents.loadURL(`${base}/next`);
      const after = await call("tab.devtools", id, { read: "dom" });
      out.fills[name] = { before, filled: state.filled.status, reason: state.filled.reason, refused, closedWhenTyped: state.closedWhenTyped,
        sent: asked.some(url => secret.test(url)), after: after.status, rowsAfter: await rowsOf(id), vaultAfter: Boolean(tab.vaultFilled) };
      browser.close(id);
      await settle(100);
    }

    // A sign-in that moves on within its document, as a single-page app's does.
    {
      asked.length = 0;
      const { id, tab, state } = await openFilled(fills["sign-in"]);
      const flagged = { filled: state.filled.status, vault: Boolean(tab.vaultFilled), refused: await reasons(id), sent: asked.some(url => secret.test(url)) };
      await moveWithin(tab, "history.replaceState({}, '', location.href); 0");
      const sameUrl = await reasons(id);
      await moveWithin(tab, "history.pushState({}, '', '/home'); 0");
      const read = await call("tab.devtools", id, { read: "console" });
      out.signInWithin = { ...flagged, sameUrl, moved: await reasons(id), rows: await rowsOf(id), console: read.entries?.length, fromLoad: read.from_load, vault: Boolean(tab.vaultFilled) };
      browser.close(id);
      await settle(100);
    }

    // A card stays closed until a new document; so does a fill that breaks partway.
    {
      const { id, tab, state } = await openFilled(fills.card);
      await moveWithin(tab, "history.pushState({}, '', '/paid'); 0");
      out.cardWithin = { filled: state.filled.status, vault: Boolean(tab.vaultFilled), moved: await reasons(id) };
      browser.close(id);
      await settle(100);
      const broken = await openFilled(fills.card, () => { throw new Error("typing failed"); });
      out.cardBroken = { filled: broken.state.filled.status, closedWhenTyped: broken.state.closedWhenTyped, vault: Boolean(broken.tab.vaultFilled), refused: await reasons(broken.id) };
      browser.close(broken.id);
      await settle(100);
    }
  }
  save();
  clearTimeout(hardStop);
  server.close();
  app.exit(0);
}
app.on("window-all-closed", () => {});
app.whenReady().then(main).catch(fail);

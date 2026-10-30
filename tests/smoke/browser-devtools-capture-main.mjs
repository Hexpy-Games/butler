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
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("Content-Type", "text/html");
    if (path === "/hang") return undefined;
    if (path === "/with-fetch") return res.end(page("<script>fetch('/sub')</script>"));
    if (path === "/fields") return res.end(page(`<input name="cardNumber" value="4242"><p>${"\u0001".repeat(400)}</p>`.repeat(300)));
    if (path === "/signin") return res.end(page(`<form onsubmit="return false"><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"></form><script>console.error("sign-in page")</script>`));
    if (path === "/pay") return res.end(page(`<form onsubmit="return false"><input name="cardNumber" autocomplete="cc-number" aria-label="Card number"><input name="exp" autocomplete="cc-exp" aria-label="Expiry"><input name="cvc" autocomplete="cc-csc" aria-label="CVC"></form><script>console.error("pay page")</script>`));
    res.writeHead(200); return res.end(page("<p>page</p>"));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
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
    out.fills = {};
    for (const [name, { path, op, args }] of Object.entries(fills)) {
      const opened = await call("tab.open", undefined, { url: `${base}${path}`, signed_in: true });
      const before = { console: (await call("tab.devtools", opened.tab, { read: "console" })).status, dom: (await call("tab.devtools", opened.tab, { read: "dom" })).status };
      const filled = await call(op, opened.tab, args);
      const refused = { console: await call("tab.devtools", opened.tab, { read: "console" }), dom: await call("tab.devtools", opened.tab, { read: "dom" }), network: (await call("tab.devtools", opened.tab, { read: "network" })).status };
      const tab = browser.tabs.get(opened.tab);
      await tab.view.webContents.loadURL(`${base}/next`);
      const after = await call("tab.devtools", opened.tab, { read: "dom" });
      out.fills[name] = { before, filled: filled.status, reason: filled.reason, console: refused.console.reason, dom: refused.dom.reason, network: refused.network, after: after.status };
      browser.close(opened.tab);
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

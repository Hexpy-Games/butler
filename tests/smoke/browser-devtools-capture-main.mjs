// The real App capture code in real Electron against a local server: which logins
// it sees, how a tab reached a loopback page, and what crosses a navigation.
// `remote.test` and friends resolve to the local server, so they read as public sites.
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const out = {};
const save = () => writeFileSync(process.env.DEVTOOLS_CAPTURE_OUT, JSON.stringify(out, null, 1));
const fail = error => { console.error(String(error?.stack ?? error)); save(); app.exit(3); };
const hardStop = setTimeout(() => fail("hard stop"), 90_000);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
app.commandLine.appendSwitch("host-resolver-rules", "MAP *.test 127.0.0.1");

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (win, code) => win.webContents.executeJavaScript(code);
const page = body => `<!doctype html><meta charset="utf-8"><title>t</title>${body}`;

async function main() {
  app.dock?.hide();
  const { watchDevtools, watchArrival, noteUserHold, devtoolsCall } = await import(`${process.env.DEVTOOLS_BROWSER_DIR}/devtools.mjs`);
  let local = "";
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("Content-Type", "text/html");
    if (path === "/login-302") { res.writeHead(302, { Location: "/home", "Set-Cookie": "sid=A; HttpOnly; Path=/" }); return res.end(); }
    if (path === "/callback") { res.writeHead(200, { "Set-Cookie": "opaque=C; HttpOnly; Path=/" }); return res.end(page("<p>signed in</p>")); }
    if (path === "/callback-302") { res.writeHead(302, { Location: "/home", "Set-Cookie": "opaque=C; HttpOnly; Path=/" }); return res.end(); }
    if (path === "/login-plain") { res.writeHead(200, { "Set-Cookie": "PHPSESSID=D; Path=/" }); return res.end(page("ok")); }
    if (path === "/to-local") { res.writeHead(302, { Location: `${local}/containers` }); return res.end(); }
    if (path === "/hang") return undefined;
    if (path === "/with-fetch") return res.end(page("<script>fetch('/sub')</script>"));
    if (path === "/fields") return res.end(page(`<input name="cardNumber" value="4242"><p>${"\u0001".repeat(400)}</p>`.repeat(300)));
    res.writeHead(200); return res.end(page("<p>page</p>"));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const remote = `http://remote.test:${port}`;
  local = `http://localhost:${port}`;
  let partition = 0;
  async function makeTab(start = remote, extra = {}) {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: `capture-${partition++}`, sandbox: true, contextIsolation: true } });
    const tab = { id: `t${partition}`, view: win, session: win.webContents.session, url: start, profile: "signed_out", agent: true, status: "idle", ...extra };
    watchArrival(tab);
    watchDevtools(tab);
    await win.loadURL(start);
    tab.url = win.webContents.getURL();
    return { win, tab };
  }
  const place = tab => devtoolsCall(tab, "tab.devtools_place", {});
  const close = async win => { win.destroy(); await settle(100); };
  const navigated = win => new Promise(resolve => {
    win.webContents.once("did-finish-load", resolve);
    win.webContents.once("did-fail-load", resolve);
  });
  const submit = (win, action) => {
    const done = navigated(win);
    void js(win, `document.body.innerHTML='<form method=post action=${action}><input name=u value=1></form>';document.forms[0].submit();0`).catch(() => {});
    return done;
  };

  // Which logins the read sees.
  const logins = {
    "form POST, 302, HttpOnly": win => submit(win, "/login-302"),
    "GET callback, 200, HttpOnly": win => win.loadURL(`${remote}/callback?code=abc`),
    "GET callback, 302, HttpOnly": win => win.loadURL(`${remote}/callback-302?code=abc`),
    "form POST, PHPSESSID without HttpOnly": win => submit(win, "/login-plain"),
    "cookie set by script": win => js(win, "document.cookie='session=E; path=/';0"),
    "cookie already in the partition": async (win, tab) => { await tab.session.cookies.set({ url: remote, name: "sid", value: "F", httpOnly: true }); },
    "Authorization header": win => js(win, "fetch('/x',{headers:{Authorization:'Bearer abc'}}).then(r=>r.text())"),
    "no login: analytics cookie": win => js(win, "document.cookie='_ga=G; path=/';0"),
    "no login: Butler's preview cookie": async (win, tab) => { await tab.session.cookies.set({ url: remote, name: "butler_preview", value: "H", httpOnly: true }); },
  };
  out.logins = {};
  for (const [name, drive] of Object.entries(logins)) {
    const { win, tab } = await makeTab();
    await drive(win, tab);
    await settle(150);
    out.logins[name] = (await place(tab)).credentialed_hosts;
    await close(win);
  }

  // A full host set reads as signed in.
  {
    const { win, tab } = await makeTab();
    for (let i = 0; i < 70; i++) await tab.session.cookies.set({ url: `http://h${i}.test`, name: "sid", value: "x" });
    const report = await place(tab);
    out.overflow = { flag: report.credentials_overflow, hosts: report.credentialed_hosts.length };
    await close(win);
  }

  // The user held the tab; a loopback page the user holds stays as it was.
  {
    const { win, tab } = await makeTab();
    out.userHold = { before: (await place(tab)).credentialed_hosts };
    tab.holder = "user";
    noteUserHold(tab);
    await win.loadURL(`http://other.test:${port}/`);
    out.userHold.after = (await place(tab)).credentialed_hosts;
    await close(win);
    const onLocal = await makeTab(local);
    onLocal.tab.holder = "user";
    noteUserHold(onLocal.tab);
    await onLocal.win.loadURL(`${local}/next`);
    out.userHold.local = (await place(onLocal.tab)).credentialed_hosts;
    await close(onLocal.win);
  }

  // How the tab reached a loopback page.
  const arrivals = {
    "opened by the user": async () => {},
    "page moved it from a remote site": async win => { await win.loadURL(remote); const done = navigated(win); void js(win, `location=${JSON.stringify(`${local}/containers`)};0`).catch(() => {}); await done; },
    "reload after a page moved it": async win => { await win.loadURL(remote); const done = navigated(win); void js(win, `location=${JSON.stringify(`${local}/containers`)};0`).catch(() => {}); await done; await win.webContents.reload(); await navigated(win); },
    "link on a local page": async win => { const done = navigated(win); void js(win, "location='/next';0").catch(() => {}); await done; },
    "remote redirect to loopback": async win => { await win.loadURL(`${remote}/to-local`); },
    "user typed it after a page moved it": async win => { await win.loadURL(remote); const done = navigated(win); void js(win, `location=${JSON.stringify(`${local}/containers`)};0`).catch(() => {}); await done; await win.loadURL(`${local}/typed`); },
  };
  out.arrivals = {};
  for (const [name, drive] of Object.entries(arrivals)) {
    const { win, tab } = await makeTab(local);
    await drive(win, tab);
    await settle(100);
    const report = await place(tab);
    out.arrivals[name] = { url: report.url, trusted: report.local_trusted };
    await close(win);
  }
  {
    const { win, tab } = await makeTab(local, { opener: "parent" });
    out.arrivals["opened as a pop-up"] = { url: (await place(tab)).url, trusted: (await place(tab)).local_trusted };
    await close(win);
  }

  // What crosses a navigation, and whether the new document's own requests stay.
  {
    const { win, tab } = await makeTab();
    void js(win, "fetch('/hang?from=OLD_DOCUMENT').catch(()=>{});0").catch(() => {});
    await settle(200);
    await win.loadURL(`http://localhost:${port}/with-fetch`).catch(() => {});
    await settle(300);
    const read = await devtoolsCall(tab, "tab.devtools", { read: "network" });
    out.crossing = { status: read.status, rows: read.entries?.map(row => row.url) };
    await close(win);
  }

  // Requests that never finish stay bounded.
  {
    const { win, tab } = await makeTab();
    void js(win, "for(let i=0;i<800;i++)fetch('/hang?i='+i).catch(()=>{});0").catch(() => {});
    await settle(800);
    const read = await devtoolsCall(tab, "tab.devtools", { read: "network" });
    out.pending = { total: read.total, dropped: read.dropped, bytes: Buffer.byteLength(JSON.stringify(read)) };
    await close(win);
  }

  // A DOM reply stays inside a host reply, even when JSON expands the text; it says where it stands.
  {
    const { win, tab } = await makeTab(`${remote}/fields`);
    const read = await devtoolsCall(tab, "tab.devtools", { read: "dom" });
    out.dom = { status: read.status, bytes: Buffer.byteLength(JSON.stringify(read)), walked_all: read.walked_all, href: read.href, url: read.url };
    out.selector = { invalid: await devtoolsCall(tab, "tab.devtools_place", { selector: "[[" }), valid: (await devtoolsCall(tab, "tab.devtools_place", { selector: "p" })).status };
    await close(win);
  }
  save();
  clearTimeout(hardStop);
  server.close();
  app.exit(0);
}
app.on("window-all-closed", () => {});
app.whenReady().then(main).catch(fail);

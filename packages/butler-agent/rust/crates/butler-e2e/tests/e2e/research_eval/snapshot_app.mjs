// The App's executor, with every page request fulfilled from the saved corpus.
import { app, session, Menu } from "electron";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const token = process.env.BUTLER_RESEARCH_HOST_TOKEN;
const admin = process.env.BUTLER_RESEARCH_HOST_ADMIN;
for (const key of ["BUTLER_RESEARCH_HOST_TOKEN", "BUTLER_RESEARCH_HOST_ADMIN", "DEEPSEEK_API_KEY"]) delete process.env[key];
app.setPath("userData", config.profile);
app.setPath("sessionData", config.profile);
for (const flag of ["use-mock-keychain", "disable-renderer-backgrounding", "disable-background-networking", "disable-component-update", "disable-sync", "disable-quic"]) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch("password-store", "basic");
app.commandLine.appendSwitch("proxy-server", config.sink);
app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>");
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.on("window-all-closed", () => {});
const pages = new Map(Object.entries(config.pages).map(([url, page]) => { const key = new URL(url); key.hash = ""; return [key.href, page]; }));
const localOrigins = new Set();
const configured = new WeakSet();
const announce = async value => {
  const reply = await fetch(`${config.proxy}/host-events`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  if (!reply.ok) throw new Error("host_metrics_failed");
};
function offline(profile) {
  if (configured.has(profile)) return;
  configured.add(profile);
  // No DNS or remote fetch: public URLs reach saved HTML or an ordinary 404.
  // The App still rejects private addresses and other disallowed navigation.
  profile.resolveHost = async () => ({ endpoints: [{ address: "203.0.113.1", family: "ipv4" }] });
  void profile.setProxy({ mode: "fixed_servers", proxyRules: config.sink, proxyBypassRules: "<-loopback>" });
  const handle = profile.protocol.handle.bind(profile.protocol);
  // App-owned local protocol handlers (such as its offline identity probe)
  // retain their normal behavior, without a second handler registration error.
  profile.protocol.handle = (scheme, handler) => {
    profile.protocol.unhandle(scheme);
    return handle(scheme, handler);
  };
  for (const scheme of ["http", "https"]) handle(scheme, async request => {
    const url = new URL(request.url); url.hash = "";
    if (localOrigins.has(url.origin) && url.pathname.startsWith("/__o/")) return fetch(url, { method: request.method, redirect: "manual" });
    const page = pages.get(url.href);
    if (!page) {
      // A 404 is also a page response served by this offline host.
      await announce({ offline_miss: url.href, snapshot_read: true });
      return new Response("<!doctype html><title>Not Found</title><h1>Not Found</h1>", {
        status: 404, statusText: "Not Found", headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    await announce({ snapshot_read: true });
    return new Response(page[1], { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}
app.on("session-created", offline);
void app.whenReady().then(serve).catch(error => {
  console.error("Snapshot host startup failed:", error?.stack ?? String(error));
  app.exit(1);
});
async function serve() {
  const { hideFromDock } = await import(pathToFileURL(join(config.app, "butler-platform", "app-handoff.mjs")).href);
  hideFromDock(app);
  Menu.setApplicationMenu(null);
  offline(session.defaultSession);
  const load = name => import(pathToFileURL(join(config.app, "browser", name)).href);
  const { createUserBrowser } = await load("tabs.mjs");
  const { createBrowserHost } = await load("host-channel.mjs");
  const browser = createUserBrowser(app, () => null);
  const request = async (path, init = {}) => {
    const reply = await fetch(new URL(path, config.gateway), { ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers } });
    if (path === "/internal/browser-host" && reply.ok) {
      await announce({ ready: true });
      let pending = "";
      const decoder = new TextDecoder();
      const inspect = new TransformStream({
        async transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          let end;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const event = pending.slice(0, end); pending = pending.slice(end + 2);
            const data = event.split("\n").find(line => line.startsWith("data:"));
            if (!data) continue;
            const frame = JSON.parse(data.slice(5));
            // These origins are set by the test agent's authenticated gateway.
            const origin = frame.lease?.content_origin ?? frame.args?.policy?.content_origin;
            if (origin && new URL(origin).hostname === "127.0.0.1") localOrigins.add(new URL(origin).origin);
            await announce({ op: frame.op });
          }
          controller.enqueue(chunk);
        },
      });
      return new Response(reply.body.pipeThrough(inspect), { status: reply.status, headers: reply.headers });
    }
    if (path.startsWith("/internal/browser-host/renders/") && reply.ok) await announce({ reader_reply: true });
    return reply;
  };
  const host = createBrowserHost({
    stillDirectory: config.stills,
    fetch: request,
    adminCredential: () => admin,
    executeBrowser: async frame => {
      try {
        const result = await browser.execute(frame);
        if (result?.reason === "unsupported_op") await announce({ unknown: true });
        return result;
      } catch (error) {
        await announce({ host_error: String(error?.message ?? error) });
        throw error;
      }
    },
    resetBrowser: () => browser.resetUse(),
    snapshot: () => browser.snapshot(),
    enabled: () => browser.enabled(),
    onClosed: () => { app.quit(); setTimeout(() => app.exit(0), 5000).unref(); },
  });
  browser.history = host.history;
  browser.downloadRequest = async input => {
    const reply = await request("/internal/browser-host/downloads", { method: "POST",
      headers: { "content-type": "application/json", "x-butler-admin": admin }, body: JSON.stringify(input) });
    if (!reply.ok) throw new Error("download_request_failed");
    return reply.json();
  };
  browser.onState = () => host.changed();
  host.start();

}

/** web_read's render step in the App's Electron (attached or hidden host):
 * script-rendered HTML comes back, and the navigation guard holds for the
 * page, its redirects, frames and subresources. Offline loopback fixtures on
 * a stand-in output origin (`/__o/`); no window is shown. */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnElectron, stopElectronChild } from "../support/electron-child";

const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert.ok(executable, "explicit Electron 44 executable required");
const requested: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  requested.push(path);
  const html = (body: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`, { status, headers: { "content-type": "text/html" } });
  switch (path) {
    case "/__o/slow/": return html(`<main id=root>${Array.from({ length: 40 }, (_, i) => `<p>Complete source paragraph ${i}: details remain available.</p>`).join("")}</main>
      <script>const payload=${JSON.stringify("x".repeat(2 * 1024 * 1024))};fetch('/__o/poll/').catch(()=>{});setTimeout(()=>{document.querySelector('#root').insertAdjacentHTML('beforeend','<p>Latest rendered state</p>')},200)</script>
      <script async src=/__o/stream/></script>`);
    case "/__o/stream/": case "/__o/poll/": return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("// pending\n")); } }), { headers: { "content-type": "application/javascript" } });
    case "/__o/page/": return html("<main id=root>Loading</main><script>fetch('/private-data').catch(()=>{});setTimeout(()=>{document.querySelector('#root').textContent='Rendered by script'},200)</script>");
    case "/__o/redirect/": return new Response(null, { status: 302, headers: { location: "/private" } });
    case "/__o/framed/": return html("<p>Framed</p><iframe src=/private></iframe>");
    default: return html("<p>Not here</p>", 404);
  }
} });
const origin = `http://127.0.0.1:${server.port}`;
const dir = mkdtempSync(join(tmpdir(), "reader-render-smoke-"));
const results = join(dir, "results.json");
const module = pathToFileURL(resolve("packages/butler-app/client/electron/browser/reader-render.mjs")).href;
const cases = {
  slow: `${origin}/__o/slow/`, page: `${origin}/__o/page/`, missing: `${origin}/__o/missing/`, redirect: `${origin}/__o/redirect/`,
  framed: `${origin}/__o/framed/`, loopback: `${origin}/private`, private: "http://10.0.0.1/", // privacy-hygiene: allow-private-ip (LAN-denial fixture)
};
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "reader-render-smoke", main: "main.mjs", type: "module" }));
writeFileSync(join(dir, "main.mjs"), `import { app } from "electron";
import { writeFileSync } from "node:fs";
app.setPath("userData", ${JSON.stringify(join(dir, "profile"))});
app.dock?.hide();
app.on("window-all-closed", () => {});
// Electron waits for the entry's evaluation before ready: no top-level await of it.
void app.whenReady().then(async () => {
  const { renderReader } = await import(${JSON.stringify(module)});
  const out = {};
  for (const [name, url] of Object.entries(${JSON.stringify(cases)})) {
    const started = performance.now();
    out[name] = await renderReader({ url, wait_ms: name === "slow" ? 20000 : 10000, policy: { content_origin: ${JSON.stringify(origin)} } });
    out[name].duration_ms = performance.now() - started;
  }
  out.unpoliced = await renderReader({ url: ${JSON.stringify(cases.page)}, wait_ms: 10000 });
  writeFileSync(${JSON.stringify(results)}, JSON.stringify(out));
  app.exit(0);
});
`);
const logs: string[] = [];
let child: ReturnType<typeof spawnElectron> | undefined;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawnElectron(executable, [...(process.env.BUTLER_SMOKE_BROWSER_ARGS ? JSON.parse(process.env.BUTLER_SMOKE_BROWSER_ARGS) as string[] : []), dir], { onOutput: bytes => logs.push(String(bytes)), env });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { child!.kill("SIGKILL"); fail(new Error("render smoke timed out")); }, 90_000);
    child!.once("exit", () => { clearTimeout(timer); done(); });
  });
  type Render = { duration_ms: number; status: string; reason?: string; final_url?: string; http_status?: number; html_base64?: string };
  const out = JSON.parse(readFileSync(results, "utf8")) as Record<string, Render>;
  const html = (render: Render) => Buffer.from(render.html_base64 ?? "", "base64").toString("utf8");
  if (process.env.BUTLER_BROWSER_EVIDENCE) writeFileSync(join(process.env.BUTLER_BROWSER_EVIDENCE, "reader-render.json"), JSON.stringify(out));
  assert.equal(out.slow.status, "ok", JSON.stringify(out.slow));
  const slow = html(out.slow);
  for (let i = 0; i < 40; i++) assert.ok(slow.includes(`Complete source paragraph ${i}:`));
  assert.ok(slow.includes("Latest rendered state"));
  assert.ok(out.slow.duration_ms < 5000, JSON.stringify(out.slow));
  assert.equal(out.page.status, "ok", JSON.stringify(out.page));
  assert.ok(html(out.page).includes("Rendered by script"), "the settled, script-rendered page");
  assert.equal(out.page.final_url, cases.page);
  assert.equal(out.page.http_status, 200);
  assert.equal(out.missing.status, "ok");
  assert.equal(out.missing.http_status, 404);
  for (const name of ["redirect", "framed", "loopback", "private", "unpoliced"]) {
    assert.equal(out[name].status, "navigation_denied", `${name}: ${JSON.stringify(out[name])}`);
  }
  for (const path of ["/private", "/private-data"]) {
    assert.ok(!requested.includes(path), `${path} never left the browser: ${requested.join(" ")}`);
  }
  console.log(JSON.stringify({ ok: true, requested, slow_ms: out.slow.duration_ms }));
} catch (error) {
  console.error(logs.join("").slice(-4000));
  throw error;
} finally {
  if (child) await stopElectronChild(child);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}

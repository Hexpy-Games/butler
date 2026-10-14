import { spawnElectron, stopElectronChild } from "../support/electron-child";
// Space sidebar drop feedback in the real Electron client (DS spec M5).
//
// Native drags through CDP: Input.setInterceptDrags + Input.dispatchMouseEvent
// start a drag on a row; Input.dispatchDragEvent moves it across another row
// in 0.5px steps. Asserts that the drop feedback changes once per zone
// boundary (before -> group -> after, and back), that pointer jitter at a
// boundary never flips it, and that no row moves while the pointer holds
// still. A stub gateway serves the built UI; no model calls.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppServer, freePort } from "../support/native-app-server.ts";
import { LEGACY_FIRST_RUN_STORAGE_KEY as FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "butler-drop-zones-"));
// The Electron window loads the UI through a proxy on its own origin, which the
// gateway must allow (BUTLER_APP_DEV_ORIGIN); reserve that port up front.
const proxyPort = await freePort();
const origin = `http://127.0.0.1:${proxyPort}`;
const server = await createNativeAppServer({
  butlerData: join(dir, "data"), uiRoot: resolve(root, "packages/butler-app/client/ui/dist"), devOrigins: [origin],
});
await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
for (const title of ["Release notes", "Reading list", "Travel plan", "Weekly review", "Budget draft"]) {
  await server.api("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) });
}
// Unpackaged Electron waits for the agent executor; the stub gateway is ready.
const proxy = Bun.serve({
  port: proxyPort, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    // Like Vite in `app:client:dev`, the renderer's own origin serves the page;
    // the gateway answers API calls (Electron adds the bearer token) and assets.
    if (request.method === "GET" && (url.pathname === "/" || request.headers.get("accept")?.includes("text/html"))) {
      return new Response(Bun.file(resolve(root, "packages/butler-app/client/ui/dist/index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/runtime-readiness") {
      return Response.json({ protocol_version: "butler.app.v1", data: { authenticated_gateway_ready: true, btcc_executor_ready: true, executor_pid: null, executor_ready_at: null, raw_text_included: false } });
    }
    // The gateway answers only its own Host names; the renderer's Origin passes through.
    const headers = new Headers(request.headers);
    headers.delete("host");
    const init: RequestInit = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
    return fetch(new URL(`${url.pathname}${url.search}`, server.url), init);
  },
});
const electronPath = createRequire(resolve(root, "packages/butler-app/client/electron/package.json"))("electron") as unknown as string;
const debugPort = await new Promise<number>((done) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});
const electron = spawnElectron(electronPath, [`--remote-debugging-port=${debugPort}`, resolve(root, "packages/butler-app/client/electron")], {
  cwd: dir,
  stdio: "ignore",
  env: {
    ...process.env,
    // Same data folder as the gateway: Electron reads its local auth token there.
    BUTLER_DATA: server.butlerData,
    BUTLER_HOME: dir,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "electron-profile"),
    BUTLER_APP_UI_URL: `${origin}/`, BUTLER_APP_SERVER_URL: origin, BUTLER_APP_SERVER_PORT: String(proxy.port), BUTLER_APP_DEV_ORIGIN: origin,
  },
});

type Cdp = {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(method: string, listener: (params: Record<string, unknown>) => void): void;
  close(): void;
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function connect(): Promise<Cdp> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json() as Promise<Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>>).catch(() => []);
    const target = targets.find((item) => item.type === "page" && item.url.startsWith(origin) && item.webSocketDebuggerUrl);
    if (target) {
      const socket = new WebSocket(target.webSocketDebuggerUrl!);
      await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      const listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
      let next = 1;
      socket.addEventListener("message", (message) => {
        const payload = JSON.parse(String(message.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
        if (payload.method) for (const listener of listeners.get(payload.method) ?? []) listener(payload.params ?? {});
        const entry = payload.id ? pending.get(payload.id) : undefined;
        if (!entry) return;
        pending.delete(payload.id!);
        if (payload.error) entry.reject(new Error(payload.error.message ?? "CDP command failed"));
        else entry.resolve(payload.result);
      });
      return {
        send: (method, params = {}) => new Promise((resolveSend, rejectSend) => {
          const id = next++;
          pending.set(id, { resolve: resolveSend as (value: unknown) => void, reject: rejectSend });
          socket.send(JSON.stringify({ id, method, params }));
        }),
        on: (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]),
        close: () => socket.close(),
      };
    }
    await wait(250);
  }
  throw new Error("the Electron window never loaded the app");
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = await cdp.send<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, `evaluate failed: ${expression.slice(0, 80)}`);
  return result.result?.value as T;
}

async function waitFor(cdp: Cdp, expression: string, label: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await evaluate<boolean>(cdp, expression).catch(() => false)) return;
    await wait(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Box = { x: number; y: number; width: number; height: number };
type Sample = { drop: string; tops: Record<string, number> };
const headerBox = (cdp: Cdp, title: string) => evaluate<Box>(cdp, `(() => {
  const header = [...document.querySelectorAll('[data-test-class~="tree-row"]')].find((row) => row.textContent.includes(${JSON.stringify(title)}));
  const rect = header.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()`);
const SAMPLE = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const rows = [...document.querySelectorAll("[data-tree-item]")];
  const name = (row) => (row.querySelector('[data-test-class~="tree-row"]')?.textContent ?? "").trim().slice(0, 14);
  done({
    drop: rows.filter((row) => row.getAttribute("data-drop")).map((row) => name(row) + ":" + row.getAttribute("data-drop")).join(",") || "none",
    tops: Object.fromEntries(rows.map((row) => [name(row), Math.round((row.querySelector('[data-test-class~="tree-row"]')?.getBoundingClientRect().top ?? 0) * 10) / 10])),
  });
})))`;

function runs(samples: Sample[]): string[] {
  const modes = samples.map((item) => item.drop);
  return modes.filter((mode, index) => mode !== "none" && mode !== modes[index - 1]);
}

async function startDrag(cdp: Cdp, x: number, y: number) {
  let data: unknown = null;
  cdp.on("Input.dragIntercepted", (params) => { data = params.data; });
  await cdp.send("Input.setInterceptDrags", { enabled: true });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  for (let step = 1; step <= 6 && !data; step += 1) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y - step * 3, button: "left", buttons: 1 });
    await wait(30);
  }
  assert(data, "the native drag started");
  const samples: Sample[] = [];
  const drag = async (type: "dragEnter" | "dragOver" | "dragCancel", pointerY: number, delay = 16) => {
    await cdp.send("Input.dispatchDragEvent", { type, x, y: pointerY, data });
    if (type !== "dragOver") return;
    await wait(delay);
    samples.push(await evaluate<Sample>(cdp, SAMPLE));
  };
  await drag("dragEnter", y);
  const end = async (pointerY: number) => {
    await drag("dragCancel", pointerY);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: pointerY, button: "left", clickCount: 1 });
    await cdp.send("Input.setInterceptDrags", { enabled: false });
    await wait(400);
  };
  return { drag, samples, end };
}

let cdp: Cdp | null = null;
try {
  cdp = await connect();
  await waitFor(cdp, "document.readyState === \"complete\" && typeof localStorage === \"object\"", "the first load");
  await evaluate(cdp, `localStorage.setItem(${JSON.stringify(FIRST_RUN_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(legacyFirstRunCompleteRecord()))})`);
  await cdp.send("Page.reload");
  await wait(1000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 0, mobile: false });
  await waitFor(cdp, "!!document.querySelector('[data-test-class=\"app-sidebar\"]')", "the sidebar");
  await evaluate(cdp, `(() => {
    if (document.querySelector('[data-test-class="app-sidebar"]').getAttribute("data-collapsed") === "true") {
      [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show sidebar")?.click();
    }
  })()`);
  await waitFor(cdp, "[...document.querySelectorAll('[data-test-class~=\"tree-row\"]')].some((row) => row.textContent.includes(\"Travel plan\") && row.getBoundingClientRect().width > 0)", "the tree rows");
  await wait(600);
  const source = await headerBox(cdp, "Budget draft");
  const target = await headerBox(cdp, "Travel plan");
  const x = source.x + 60;

  // 1. A slow sweep down across the target row and back up.
  {
    const { drag, samples, end } = await startDrag(cdp, x, source.y + source.height / 2);
    for (let y = source.y - 18; y > target.y - 12; y -= 6) await drag("dragOver", y);
    const top = target.y - 8;
    const bottom = target.y + target.height + 8;
    for (let y = top; y <= bottom; y += 0.5) await drag("dragOver", y, 24);
    for (let y = bottom; y >= top; y -= 0.5) await drag("dragOver", y, 24);
    await end(top);
    const sequence = runs(samples);
    console.log(JSON.stringify({ sweep: sequence }));
    assert.deepEqual(sequence, [
      "Weekly review:after", "Travel plan:before", "Travel plan:group", "Travel plan:after", "Reading list:before",
      "Travel plan:after", "Travel plan:group", "Travel plan:before", "Weekly review:after",
    ], "the feedback changes once per zone boundary");
  }

  // 2. Jitter (+-1.5px) at the before|group boundary, then hold still.
  {
    const { drag, samples, end } = await startDrag(cdp, x, source.y + source.height / 2);
    for (let y = source.y - 18; y > target.y - 12; y -= 6) await drag("dragOver", y);
    const edge = target.y + target.height * 0.25;
    for (let y = target.y - 8; y < edge - 1.5; y += 1) await drag("dragOver", y);
    const jitterStart = samples.length;
    for (let event = 0; event < 60; event += 1) await drag("dragOver", edge + (event % 2 ? 1.5 : -1.5));
    const holdStart = samples.length;
    for (let event = 0; event < 20; event += 1) await drag("dragOver", edge);
    await end(edge);
    const jitter = runs(samples.slice(jitterStart));
    console.log(JSON.stringify({ jitter }));
    assert.deepEqual(jitter, ["Travel plan:before"], "jitter at a boundary never flips the zone");
    const hold = samples.slice(holdStart);
    for (const item of hold) assert.deepEqual(item.tops, hold[0]!.tops, "rows hold still while the pointer holds still");
  }
} finally {
  cdp?.close();
  await stopElectronChild(electron);
  proxy.stop(true);
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log("sidebar drop zones: ok");
process.exit(0);

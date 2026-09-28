// Bundled fonts render in the served UI (DS spec Typeface Contract).
//
// Web mode: Playwright Chromium against an isolated native gateway serving the
// built UI. Electron mode: the real Electron client loading the same gateway
// (through a readiness proxy, as in sidebar-drop-zones-electron.ts). In both,
// document.fonts must report Pretendard Variable loaded, and CDP
// CSS.getPlatformFontsForNode must show UI text rendered in Pretendard
// Variable, Latin code in IBM Plex Mono and Hangul code in Pretendard. The
// report lists the font bytes an initial app load fetches per locale. No
// model calls; skip Electron with BUTLER_FONT_SMOKE_ELECTRON=0.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer, freePort } from "../support/native-app-server.ts";
import { LEGACY_FIRST_RUN_STORAGE_KEY as FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
type FontLoad = { files: number; bytes: number; family: string; pretendardLoaded: number; check: boolean };
type Rendered = Record<"text" | "code" | "codeHangul", string[]>;

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "butler-font-smoke-"));
// The Electron window loads the UI through a proxy on its own origin, which the
// gateway must allow (BUTLER_APP_DEV_ORIGIN); reserve that port up front.
const proxyPort = await freePort();
const origin = `http://127.0.0.1:${proxyPort}`;
const server = await createNativeAppServer({
  butlerData: join(dir, "data"), uiRoot: resolve(root, "packages/butler-app/client/ui/dist"), devOrigins: [origin],
});
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Runs in the page after load: what the initial render fetched and resolved.
const LOAD_PROBE = `(async () => {
  await document.fonts.ready;
  await new Promise((done) => setTimeout(done, 300));
  const fonts = performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith(".woff2"));
  return {
    files: fonts.length,
    bytes: fonts.reduce((total, entry) => total + (entry.encodedBodySize || entry.transferSize || 0), 0),
    family: getComputedStyle(document.body).fontFamily,
    pretendardLoaded: [...document.fonts].filter((face) => face.family.includes("Pretendard Variable") && face.status === "loaded").length,
    check: document.fonts.check('14px "Pretendard Variable"', "Butler 버틀러"),
  };
})()`;

// Adds probe text in the body and code stacks and waits for their faces.
const PROBE_NODES = `(async () => {
  const make = (id, family, text) => {
    const node = document.createElement("span");
    node.id = id;
    node.style.fontFamily = family;
    node.textContent = text;
    document.body.append(node);
  };
  make("font-probe-text", "var(--font-body)", "Butler settings 버틀러 설정");
  make("font-probe-code", "var(--font-family-code)", "const value = 1;");
  make("font-probe-code-hangul", "var(--font-family-code)", "한글");
  await Promise.all([
    document.fonts.load('14px "Pretendard Variable"', "Butler 버틀러 설정 한글"),
    document.fonts.load('13px "IBM Plex Mono"', "const value = 1;"),
  ]);
  await document.fonts.ready;
  return true;
})()`;

async function renderedFaces(send: Send): Promise<Rendered> {
  await send("DOM.enable");
  await send("CSS.enable");
  const { root: documentNode } = await send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  const faces = async (selector: string) => {
    const { nodeId } = await send<{ nodeId: number }>("DOM.querySelector", { nodeId: documentNode.nodeId, selector });
    const { fonts } = await send<{ fonts: Array<{ familyName: string }> }>("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((font) => font.familyName);
  };
  return {
    text: await faces("#font-probe-text"),
    code: await faces("#font-probe-code"),
    codeHangul: await faces("#font-probe-code-hangul"),
  };
}

function assertFonts(mode: string, load: FontLoad, rendered: Rendered): void {
  assert.match(load.family, /^"Pretendard Variable"/u, `${mode}: body font-family`);
  assert.ok(load.check && load.pretendardLoaded > 0, `${mode}: Pretendard Variable is not loaded: ${JSON.stringify(load)}`);
  assert.deepEqual(rendered.text, ["Pretendard Variable"], `${mode}: UI text face`);
  assert.deepEqual(rendered.code, ["IBM Plex Mono"], `${mode}: code face`);
  assert.deepEqual(rendered.codeHangul, ["Pretendard Variable"], `${mode}: Hangul code face`);
}

const report: Record<string, unknown> = {};

async function webMode(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const locale of ["en", "ko"] as const) {
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale }) });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await server.signIn(context);
      const page = await context.newPage();
      await page.addInitScript(
        ({ key, value }) => window.localStorage.setItem(key, value),
        { key: FIRST_RUN_STORAGE_KEY, value: JSON.stringify(legacyFirstRunCompleteRecord()) },
      );
      await page.goto(server.url, { waitUntil: "load" });
      await page.locator('[data-test-class~="composer-card"]').waitFor({ state: "visible" });
      const load = await page.evaluate(LOAD_PROBE) as FontLoad;
      await page.evaluate(PROBE_NODES);
      const cdp = await context.newCDPSession(page);
      const rendered = await renderedFaces((method, params) => cdp.send(method as never, params as never) as never);
      assertFonts(`web ${locale}`, load, rendered);
      report[`web-${locale}`] = { initialFontFiles: load.files, initialFontBytes: load.bytes, rendered };
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function electronMode(): Promise<void> {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
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
  const debugPort = await freePort();
  const electron = spawn(electronPath, [`--remote-debugging-port=${debugPort}`, resolve(root, "packages/butler-app/client/electron")], {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      // Same data folder as the gateway: Electron reads its local auth token there.
      BUTLER_DATA: server.butlerData, BUTLER_HOME: dir,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "electron-profile"),
      BUTLER_APP_UI_URL: `${origin}/`, BUTLER_APP_SERVER_URL: origin, BUTLER_APP_SERVER_PORT: String(proxy.port), BUTLER_APP_DEV_ORIGIN: origin,
    },
  });
  let socket: WebSocket | undefined;
  try {
    let target: { webSocketDebuggerUrl?: string } | undefined;
    for (let attempt = 0; attempt < 200 && !target; attempt += 1) {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        .then((response) => response.json() as Promise<Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>>)
        .catch(() => []);
      target = targets.find((item) => item.type === "page" && item.url.startsWith(origin) && item.webSocketDebuggerUrl);
      if (!target) await wait(250);
    }
    assert.ok(target?.webSocketDebuggerUrl, "the Electron window never loaded the app");
    const open = new WebSocket(target.webSocketDebuggerUrl);
    socket = open;
    await new Promise((done, fail) => { open.addEventListener("open", done, { once: true }); open.addEventListener("error", fail, { once: true }); });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let next = 1;
    open.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      const entry = payload.id ? pending.get(payload.id) : undefined;
      if (!entry) return;
      pending.delete(payload.id!);
      if (payload.error) entry.reject(new Error(payload.error.message ?? "CDP command failed"));
      else entry.resolve(payload.result);
    });
    const send: Send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
      const id = next++;
      pending.set(id, { resolve: resolveSend as (value: unknown) => void, reject: rejectSend });
      open.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await send<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
      return result.result?.value as T;
    };
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await evaluate<boolean>("document.readyState === 'complete' && Boolean(document.querySelector('#root > *'))").catch(() => false)) break;
      await wait(200);
    }
    const load = await evaluate<FontLoad>(LOAD_PROBE);
    await evaluate(PROBE_NODES);
    const rendered = await renderedFaces(send);
    assertFonts("electron", load, rendered);
    report.electron = { initialFontFiles: load.files, initialFontBytes: load.bytes, rendered };
  } finally {
    socket?.close();
    electron.kill("SIGTERM");
    await Promise.race([new Promise((done) => electron.once("exit", done)), wait(5000)]);
    if (electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
    proxy.stop(true);
  }
}

try {
  await webMode();
  if (process.env.BUTLER_FONT_SMOKE_ELECTRON !== "0") await electronMode();
  console.log(JSON.stringify(report, null, 2));
  console.log("font render smoke passed");
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}

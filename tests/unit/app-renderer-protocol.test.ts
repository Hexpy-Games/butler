import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_RENDERER_ENTRY_URL,
  APP_RENDERER_HOST,
  APP_RENDERER_ORIGIN,
  APP_RENDERER_SCHEME,
  APP_RENDERER_SCHEME_PRIVILEGES,
  createAppRendererProtocolHandler,
  findRendererDistRoot,
  isAppRendererDocumentUrl,
  rendererMimeType,
  rendererOriginForUrl,
  selectRendererUrl,
} from "../../packages/butler-app/client/electron/app-renderer-protocol.mjs";

const secret = "outside-dist-secret";
let root = "";
let distRoot = "";
let handler: (request: Request) => Promise<Response>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "butler-renderer-protocol-"));
  distRoot = join(root, "dist");
  mkdirSync(join(distRoot, "assets"), { recursive: true });
  writeFileSync(join(distRoot, "index.html"), "<!doctype html><title>Butler</title>");
  writeFileSync(join(distRoot, "assets", "index-abc.js"), "export {};");
  writeFileSync(join(distRoot, "assets", "index-abc.css"), "body{}");
  writeFileSync(join(distRoot, "assets", "butler-mark.png"), "png");
  writeFileSync(join(distRoot, "assets", "data.bin"), "bin");
  writeFileSync(join(root, "secret.txt"), secret);
  symlinkSync(join(root, "secret.txt"), join(distRoot, "assets", "escape.js"));
  handler = createAppRendererProtocolHandler({ distRoot });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(url: string, init: RequestInit = {}) {
  return handler(new Request(url, init));
}

test("app scheme is a privileged standard secure scheme on a fixed host", () => {
  expect(APP_RENDERER_SCHEME).toBe("app");
  expect(APP_RENDERER_HOST).toBe("butler");
  expect(APP_RENDERER_ORIGIN).toBe("app://butler");
  expect(APP_RENDERER_ENTRY_URL).toBe("app://butler/index.html");
  expect(APP_RENDERER_SCHEME_PRIVILEGES).toEqual({
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  });
});

test("production renders from app://butler, dev keeps Vite, missing dist falls back to the gateway", () => {
  const serverUrl = "http://127.0.0.1:18765/";
  expect(selectRendererUrl({ staticDistRoot: distRoot, serverUrl }))
    .toBe("app://butler/index.html");
  expect(selectRendererUrl({
    devUrl: "http://127.0.0.1:5173/",
    staticDistRoot: distRoot,
    serverUrl,
  })).toBe("http://127.0.0.1:5173/");
  expect(selectRendererUrl({ staticDistRoot: null, serverUrl })).toBe(serverUrl);
});

test("renderer dist root is the first candidate that holds index.html", () => {
  expect(findRendererDistRoot([null, join(root, "missing"), distRoot, root]))
    .toBe(distRoot);
  expect(findRendererDistRoot([undefined, join(root, "missing")])).toBeNull();
});

test("renderer origin is app://butler for the app scheme and the URL origin otherwise", () => {
  // WHATWG URL reports "null" for non-special schemes; Chromium treats the
  // registered standard scheme as a tuple origin.
  expect(new URL(APP_RENDERER_ENTRY_URL).origin).toBe("null");
  expect(rendererOriginForUrl(APP_RENDERER_ENTRY_URL)).toBe("app://butler");
  expect(rendererOriginForUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173");
  expect(rendererOriginForUrl("http://127.0.0.1:18765/")).toBe("http://127.0.0.1:18765");
});

test("only the app entry document counts as in-app navigation", () => {
  expect(isAppRendererDocumentUrl("app://butler/")).toBe(true);
  expect(isAppRendererDocumentUrl("app://butler/index.html?visual=design-system#x")).toBe(true);
  expect(isAppRendererDocumentUrl("app://butler/assets/index-abc.js")).toBe(false);
  expect(isAppRendererDocumentUrl("app://butler/notes.md")).toBe(false);
  expect(isAppRendererDocumentUrl("app://evil/index.html")).toBe(false);
  expect(isAppRendererDocumentUrl("app://butler:8080/index.html")).toBe(false);
  expect(isAppRendererDocumentUrl("file:///index.html")).toBe(false);
  expect(isAppRendererDocumentUrl("data:text/html,hi")).toBe(false);
  expect(isAppRendererDocumentUrl("http://127.0.0.1:5173/")).toBe(false);
  expect(isAppRendererDocumentUrl("not a url")).toBe(false);
});

test("MIME types cover the built renderer assets", () => {
  expect(rendererMimeType("index.html")).toBe("text/html; charset=utf-8");
  expect(rendererMimeType("a/index-abc.js")).toBe("text/javascript; charset=utf-8");
  expect(rendererMimeType("a/chunk.MJS")).toBe("text/javascript; charset=utf-8");
  expect(rendererMimeType("a/index.css")).toBe("text/css; charset=utf-8");
  expect(rendererMimeType("a/mark.png")).toBe("image/png");
  expect(rendererMimeType("a/icon.svg")).toBe("image/svg+xml");
  expect(rendererMimeType("a/font.woff2")).toBe("font/woff2");
  expect(rendererMimeType("a/data.json")).toBe("application/json");
  expect(rendererMimeType("a/module.wasm")).toBe("application/wasm");
  expect(rendererMimeType("a/data.bin")).toBe("application/octet-stream");
});

test("handler serves the entry document and assets with their MIME types", async () => {
  for (const url of ["app://butler/", "app://butler/index.html", "app://butler/index.html?visual=x"]) {
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("<title>Butler</title>");
  }
  const script = await request("app://butler/assets/index-abc.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const style = await request("app://butler/assets/index-abc.css");
  expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
  const image = await request("app://butler/assets/butler-mark.png");
  expect(image.headers.get("content-type")).toBe("image/png");
  const binary = await request("app://butler/assets/data.bin");
  expect(binary.headers.get("content-type")).toBe("application/octet-stream");
});

test("handler answers HEAD without a body and rejects other methods", async () => {
  const head = await request("app://butler/index.html", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await head.text()).toBe("");
  const post = await request("app://butler/index.html", { method: "POST", body: "x" });
  expect(post.status).toBe(405);
});

test("handler rejects path traversal, encoded separators and symlink escapes", async () => {
  const attempts = [
    "app://butler/../secret.txt",
    "app://butler/%2e%2e/secret.txt",
    "app://butler/..%2fsecret.txt",
    "app://butler/assets/..%2f..%2fsecret.txt",
    "app://butler/%2e%2e%2fsecret.txt",
    "app://butler/..%5csecret.txt",
    "app://butler/assets%5c..%5c..%5csecret.txt",
    `app://butler/${encodeURIComponent(join(root, "secret.txt"))}`,
    "app://butler/index.html%00.js",
    "app://butler/%E0%A4%A",
    "app://butler/assets/escape.js",
  ];
  for (const url of attempts) {
    const response = await request(url);
    expect(response.status, url).toBeGreaterThanOrEqual(400);
    expect(await response.text(), url).not.toContain(secret);
  }
  expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe(secret);
});

test("handler serves only the butler host", async () => {
  expect((await request("app://other/index.html")).status).toBe(404);
  expect((await request("app://butler:8080/index.html")).status).toBe(404);
});

test("no SPA fallback: the UI has no path routes, so unknown paths are 404 even for navigations", async () => {
  const navigation = await request("app://butler/settings", {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  expect(navigation.status).toBe(404);
  expect((await request("app://butler/assets/missing.js")).status).toBe(404);
  expect((await request("app://butler/assets")).status).toBe(404);
  expect((await request("app://butler/assets/")).status).toBe(404);
});

test("main process loads production UI through the app protocol", () => {
  const main = readFileSync(
    join(import.meta.dir, "../../packages/butler-app/client/electron/main.mjs"),
    "utf8",
  );
  expect(main).toContain("protocol.registerSchemesAsPrivileged([APP_RENDERER_SCHEME_PRIVILEGES])");
  expect(main).toContain("distRoot: staticRendererDistRoot");
  expect(main).toContain('noticesFile: app.isPackaged ? join(process.resourcesPath, "bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz") : null');
  expect(main).toMatch(/protocol\.handle\(\s*APP_RENDERER_SCHEME,/u);
  expect(main).toContain("migrateRendererStorageOrigin({");
  expect(main).toContain("await prepareAppRendererProtocol();\n  await win.loadURL(rendererUrl);");
  expect(main).toContain("rendererOrigin = rendererOriginForUrl(rendererUrl)");
  expect(main).toContain("isAppRendererDocumentUrl(value)");
  expect(main).not.toContain("pathToFileURL(indexPath)");
  expect(main).not.toContain('renderer.protocol === "file:"');
});

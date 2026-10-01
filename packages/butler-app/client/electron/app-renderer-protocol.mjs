import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

// The packaged renderer runs on its own origin instead of file://. A file://
// page has no distinguishable origin, and any website can forge `Origin: null`
// from a sandboxed iframe, so the gateway cannot allowlist it.
export const APP_RENDERER_SCHEME = "app";
export const APP_RENDERER_HOST = "butler";
export const APP_RENDERER_ORIGIN = `${APP_RENDERER_SCHEME}://${APP_RENDERER_HOST}`;
export const APP_RENDERER_ENTRY_URL = `${APP_RENDERER_ORIGIN}/index.html`;
export const APP_RENDERER_SCHEME_PRIVILEGES = Object.freeze({
  scheme: APP_RENDERER_SCHEME,
  privileges: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  }),
});

const entryDocumentPaths = new Set(["/", "/index.html"]);
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".txt", "text/plain; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".wasm", "application/wasm"],
]);

export function selectRendererUrl({ devUrl = null, staticDistRoot = null, serverUrl }) {
  if (devUrl) return devUrl;
  if (staticDistRoot) return APP_RENDERER_ENTRY_URL;
  return serverUrl;
}

export function findRendererDistRoot(candidates, fileExists = existsSync) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = resolve(candidate);
    if (fileExists(resolve(root, "index.html"))) return root;
  }
  return null;
}

export function rendererOriginForUrl(url) {
  return appRendererUrl(url) ? APP_RENDERER_ORIGIN : new URL(url).origin;
}

export function isAppRendererDocumentUrl(value) {
  const url = appRendererUrl(value);
  return Boolean(url && entryDocumentPaths.has(url.pathname));
}

export function rendererMimeType(filePath) {
  return mimeTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export function createAppRendererProtocolHandler({ distRoot, noticesFile = null }) {
  const root = resolve(distRoot);
  return async function handleAppRendererRequest(request) {
    const target = resolveRendererAsset(root, request.url, request.method);
    if (!target.ok) return new Response(null, { status: target.status });
    const pathname = new URL(request.url).pathname;
    const notice = pathname === "/THIRD_PARTY_NOTICES.txt.gz" ? noticesFile : null;
    if (notice) {
      try {
        const body = await readFile(notice);
        return new Response(request.method === "HEAD" ? null : body, {
          headers: { "content-type": rendererMimeType(notice), "x-content-type-options": "nosniff" },
        });
      } catch { return new Response(null, { status: 404 }); }
    }
    try {
      // Symlinks must not lead out of the renderer bundle.
      const [realRoot, realFile] = await Promise.all([
        realpath(root),
        realpath(target.filePath),
      ]);
      if (!isInsideDirectory(realRoot, realFile)) {
        return new Response(null, { status: 404 });
      }
      const body = await readFile(realFile);
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "content-type": rendererMimeType(realFile),
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

function resolveRendererAsset(root, requestUrl, method) {
  const url = appRendererUrl(requestUrl);
  if (!url) return { ok: false, status: 404 };
  if (method !== "GET" && method !== "HEAD") return { ok: false, status: 405 };
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  // The UI has no path routes, so there is no SPA fallback: "/" is the only
  // alias, and every other path must name a file inside the bundle.
  if (pathname.includes("\0") || pathname.includes("\\")) {
    return { ok: false, status: 404 };
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/u, "");
  const filePath = resolve(root, relativePath);
  if (!isInsideDirectory(root, filePath)) return { ok: false, status: 404 };
  return { ok: true, filePath };
}

function appRendererUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === `${APP_RENDERER_SCHEME}:` &&
    url.host.toLowerCase() === APP_RENDERER_HOST
    ? url
    : null;
}

function isInsideDirectory(root, candidate) {
  const path = relative(root, candidate);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

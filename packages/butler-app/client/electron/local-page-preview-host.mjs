import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { isSensitiveLocalPagePreviewPath } from
  "./local-page-preview-path-policy.mjs";

const DEFAULT_VIEWPORTS = [
  { name: "desktop", width: 1_440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];
const MAX_REQUEST_BYTES = 32_000;
const MAX_CONTENT_BYTES = 20 * 1024 * 1024;
const MAX_SCREENSHOT_HEIGHT = 12_000;

export function createLocalPagePreviewHost({
  BrowserWindow,
  token = randomBytes(32).toString("base64url"),
  viewports = DEFAULT_VIEWPORTS,
} = {}) {
  if (typeof BrowserWindow !== "function") {
    throw new Error("Local page preview requires Electron BrowserWindow");
  }
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("Local page preview token is invalid");
  }

  const jobs = new Map();
  const windows = new Set();
  let server = null;
  let serverUrl = null;
  let renderQueue = Promise.resolve();

  return {
    async start() {
      if (serverUrl) return serverUrl;
      server = createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          sendJson(response, 500, {
            ok: false,
            error: safeError(error, "local_page_preview_failed"),
          });
        });
      });
      await new Promise((resolveStart, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", rejectStart);
          resolveStart();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Local page preview did not bind a TCP port");
      }
      serverUrl = `http://127.0.0.1:${address.port}`;
      return serverUrl;
    },

    endpoint() {
      return serverUrl ? `${serverUrl}/v1/preview` : null;
    },

    async stop() {
      for (const win of windows) {
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch {
          // Best-effort cleanup during App shutdown.
        }
      }
      windows.clear();
      jobs.clear();
      const closing = server;
      server = null;
      serverUrl = null;
      if (!closing) return;
      await new Promise((resolveStop) => closing.close(() => resolveStop()));
    },
  };

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url ?? "/", serverUrl ?? "http://127.0.0.1");
    if (request.method === "POST" && requestUrl.pathname === "/v1/preview") {
      if (!authorized(request.headers.authorization, token)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readJsonBody(request);
      const target = resolvePreviewTarget(body);
      const jobId = randomUUID();
      jobs.set(jobId, { contentRoot: target.contentRoot });
      const renderController = new AbortController();
      const abortRender = () => renderController.abort(
        new Error("Local page preview client disconnected"),
      );
      request.once("aborted", abortRender);
      response.once("close", () => {
        if (!response.writableEnded) abortRender();
      });
      const run = async () => {
        try {
          const results = [];
          for (const viewport of viewports) {
            if (renderController.signal.aborted) {
              throw renderController.signal.reason;
            }
            results.push(await renderViewport({
              jobId,
              entryContentPath: target.entryContentPath,
              viewport,
              signal: renderController.signal,
            }));
          }
          return results;
        } finally {
          jobs.delete(jobId);
        }
      };
      const queued = renderQueue.then(run, run);
      renderQueue = queued.then(() => undefined, () => undefined);
      const results = await queued;
      sendJson(response, 200, {
        ok: results.some((result) =>
          result.loaded && result.screenshots.some((screenshot) => screenshot.base64),
        ),
        entry_path: target.entryRelativePath,
        viewports: results,
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/content/")) {
      serveWorkspaceContent(requestUrl, response);
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  }

  async function renderViewport({ jobId, entryContentPath, viewport, signal }) {
    const contentUrl = workspaceContentUrl(serverUrl, jobId, entryContentPath);
    const win = new BrowserWindow({
      show: false,
      width: viewport.width,
      height: viewport.height,
      frame: false,
      useContentSize: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        partition: `butler-page-preview-${jobId}-${viewport.name}`,
      },
    });
    windows.add(win);
    const consoleErrors = [];
    let blockedRequests = 0;
    const allowedOrigin = new URL(serverUrl).origin;
    const contentPrefix = `${serverUrl}/content/${jobId}/`;
    const requestFilter = { urls: ["*://*/*"] };
    win.webContents.session.webRequest.onBeforeRequest(
      requestFilter,
      (details, callback) => {
        const requestedUrl = new URL(details.url);
        if (details.url.startsWith(contentPrefix)) {
          callback({ cancel: false });
          return;
        }
        if (
          requestedUrl.origin === allowedOrigin &&
          requestedUrl.pathname !== "/v1/preview"
        ) {
          callback({
            redirectURL: `${contentPrefix}${requestedUrl.pathname.replace(/^\/+/, "")}${requestedUrl.search}`,
          });
          return;
        }
        blockedRequests += 1;
        callback({ cancel: true });
      },
    );
    win.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.session.on("will-download", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, nextUrl) => {
      if (new URL(nextUrl).origin === allowedOrigin) return;
      event.preventDefault();
      blockedRequests += 1;
    });
    win.webContents.on("console-message", (...args) => {
      const record = consoleMessage(args);
      if (record.level >= 2 && consoleErrors.length < 20) {
        consoleErrors.push(record.message.slice(0, 500));
      }
    });

    const cancel = () => {
      if (!win.isDestroyed()) win.destroy();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw signal.reason;
      await win.loadURL(contentUrl);
      await waitForPageAssets(win);
      await revealPageOnScroll(win);
      const facts = await pageFacts(win);
      const screenshots = await capturePageSamples(
        win,
        viewport,
        facts.scrollHeight,
      );
      return {
        name: viewport.name,
        requested_width: viewport.width,
        requested_height: viewport.height,
        inner_width: facts.innerWidth,
        client_width: facts.clientWidth,
        scroll_width: facts.scrollWidth,
        scroll_height: facts.scrollHeight,
        body_text_length: facts.bodyTextLength,
        hidden_text_elements: facts.hiddenTextElements,
        horizontal_overflow: facts.scrollWidth > facts.clientWidth + 1,
        loaded: facts.readyState === "complete" && facts.bodyTextLength > 0,
        console_errors: consoleErrors,
        blocked_external_requests: blockedRequests,
        screenshot_truncated: facts.scrollHeight > viewport.height * 2,
        screenshots,
        error: null,
      };
    } catch (error) {
      return {
        name: viewport.name,
        requested_width: viewport.width,
        requested_height: viewport.height,
        inner_width: null,
        client_width: null,
        scroll_width: null,
        scroll_height: null,
        body_text_length: null,
        hidden_text_elements: null,
        horizontal_overflow: null,
        loaded: false,
        console_errors: consoleErrors,
        blocked_external_requests: blockedRequests,
        screenshot_truncated: null,
        screenshots: [],
        error: safeError(error, "page_render_failed"),
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      try {
        win.webContents.session.webRequest.onBeforeRequest(null);
      } catch {
        // The isolated in-memory session is discarded with the window.
      }
      windows.delete(win);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  function serveWorkspaceContent(requestUrl, response) {
    const match = /^\/content\/([^/]+)\/(.*)$/u.exec(requestUrl.pathname);
    const job = match ? jobs.get(match[1]) : null;
    if (!job) {
      sendJson(response, 404, { ok: false, error: "preview_job_not_found" });
      return;
    }
    let requestedPath;
    try {
      requestedPath = decodeURIComponent(match[2] ?? "");
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid_content_path" });
      return;
    }
    serveWorkspacePath(job.contentRoot, requestedPath, response);
  }
}

function resolvePreviewTarget(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Preview request body must be an object");
  }
  const workspaceRoot = requiredString(body.workspace_root, "workspace_root");
  const entryRelativePath = requiredString(body.entry_path, "entry_path");
  if (!isAbsolute(workspaceRoot) || isAbsolute(entryRelativePath)) {
    throw new Error("Preview paths must use one absolute workspace and one relative entry");
  }
  if (entryRelativePath.split(/[\\/]+/u).includes("..")) {
    throw new Error("Preview entry cannot traverse outside the workspace");
  }
  if (isSensitiveLocalPagePreviewPath(entryRelativePath)) {
    throw new Error("Preview entry is sensitive and cannot be rendered");
  }
  const realWorkspace = realpathSync.native(workspaceRoot);
  const entryPath = realpathSync.native(resolve(realWorkspace, entryRelativePath));
  if (!inside(realWorkspace, entryPath) || !statSync(entryPath).isFile()) {
    throw new Error("Preview entry is outside the workspace or is not a file");
  }
  if (isSensitiveLocalPagePreviewPath(relative(realWorkspace, entryPath))) {
    throw new Error("Preview entry is sensitive and cannot be rendered");
  }
  return {
    contentRoot: dirname(entryPath),
    entryPath,
    entryContentPath: basename(entryPath),
    entryRelativePath: relative(realWorkspace, entryPath).split(sep).join("/"),
  };
}

async function waitForPageAssets(win) {
  await win.webContents.executeJavaScript(`(async () => {
    await document.fonts?.ready;
    await Promise.race([
      Promise.all(Array.from(document.images).map((image) => image.complete
        ? Promise.resolve()
        : new Promise((resolveImage) => {
            image.addEventListener("load", resolveImage, { once: true });
            image.addEventListener("error", resolveImage, { once: true });
          }))),
      new Promise((resolveWait) => setTimeout(resolveWait, 5000)),
    ]);
  })()`);
}

async function revealPageOnScroll(win) {
  await win.webContents.executeJavaScript(`(async () => {
    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    const pause = () => new Promise((resolvePause) => {
      requestAnimationFrame(() => requestAnimationFrame(resolvePause));
    });
    const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const step = Math.max(240, Math.floor(innerHeight * 0.7));
    for (let y = 0, count = 0; y <= maxY && count < 50; y += step, count += 1) {
      scrollTo(0, y);
      await pause();
    }
    scrollTo(0, maxY);
    await pause();
    scrollTo(0, 0);
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 850));
    root.style.scrollBehavior = previousScrollBehavior;
  })()`);
}

async function pageFacts(win) {
  return await win.webContents.executeJavaScript(`(() => {
    const hiddenTextElements = Array.from(document.body?.querySelectorAll("*") ?? [])
      .filter((element) => {
        const text = element.children.length === 0 ? element.textContent?.trim() : "";
        if (!text) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display === "none" || style.visibility === "hidden" ||
          Number(style.opacity) < 0.05 || rect.width === 0 || rect.height === 0;
      }).length;
    return {
      bodyTextLength: document.body?.innerText.trim().length ?? 0,
      clientWidth: document.documentElement.clientWidth,
      hiddenTextElements,
      innerWidth,
      readyState: document.readyState,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  })()`);
}

async function capturePageSamples(win, viewport, scrollHeight) {
  const documentHeight = Math.max(
    viewport.height,
    Math.min(MAX_SCREENSHOT_HEIGHT, Math.ceil(Number(scrollHeight) || viewport.height)),
  );
  const positions = documentHeight > viewport.height * 1.25
    ? [
        { name: "top", y: 0 },
        { name: "bottom", y: Math.max(0, documentHeight - viewport.height) },
      ]
    : [{ name: "top", y: 0 }];
  const screenshots = [];
  for (const position of positions) {
    await win.webContents.executeJavaScript(`(async () => {
      document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
      scrollTo(0, ${position.y});
      await new Promise((resolveCapture) => {
        requestAnimationFrame(() => requestAnimationFrame(resolveCapture));
      });
    })()`);
    const capture = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
    const jpeg = capture.toJPEG(68);
    if (!jpeg?.length) throw new Error("Electron did not return screenshot bytes");
    screenshots.push({
      position: position.name,
      media_type: "image/jpeg",
      base64: jpeg.toString("base64"),
    });
  }
  return screenshots;
}

function workspaceContentUrl(serverUrl, jobId, entryRelativePath) {
  return `${serverUrl}/content/${jobId}/${entryRelativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function serveWorkspacePath(workspaceRoot, requestedPath, response) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath).replace(/^\/+/, "");
  } catch {
    sendJson(response, 400, { ok: false, error: "invalid_content_path" });
    return;
  }
  if (isSensitiveLocalPagePreviewPath(decoded)) {
    sendJson(response, 403, { ok: false, error: "sensitive_content_blocked" });
    return;
  }
  const target = resolve(workspaceRoot, decoded || "index.html");
  if (!inside(workspaceRoot, target) || !existsSync(target)) {
    sendJson(response, 404, { ok: false, error: "content_not_found" });
    return;
  }
  const realTarget = realpathSync.native(target);
  if (!inside(workspaceRoot, realTarget)) {
    sendJson(response, 403, { ok: false, error: "content_outside_workspace" });
    return;
  }
  if (isSensitiveLocalPagePreviewPath(relative(workspaceRoot, realTarget))) {
    sendJson(response, 403, { ok: false, error: "sensitive_content_blocked" });
    return;
  }
  const stat = statSync(realTarget);
  if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) {
    sendJson(response, 413, { ok: false, error: "content_unavailable" });
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(stat.size),
    "content-type": contentType(realTarget),
    "x-content-type-options": "nosniff",
  });
  response.end(readFileSync(realTarget));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Preview request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function authorized(header, token) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function inside(parent, child) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function consoleMessage(args) {
  if (args[1] && typeof args[1] === "object") {
    return {
      level: Number(args[1].level) || 0,
      message: String(args[1].message ?? ""),
    };
  }
  return { level: Number(args[1]) || 0, message: String(args[2] ?? "") };
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }[extension] ?? "application/octet-stream";
}

function sendJson(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(encoded.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500) || fallback;
}

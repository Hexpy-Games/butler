import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPagePreviewHost } from
  "../../packages/butler-app/client/electron/local-page-preview-host.mjs";

test("Electron local page preview host authenticates and serves only workspace content", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-preview-host-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "dist", "assets"), { recursive: true });
  writeFileSync(join(workspace, "dist", "index.html"), "<main>Preview host</main>");
  writeFileSync(
    join(workspace, "dist", "assets", "theme.css"),
    "main{display:block}",
  );
  const loadedBodies: string[] = [];
  const securityObservations: string[] = [];
  const imageEncodingObservations: ImageEncodingObservation[] = [];
  const BrowserWindow = fakeBrowserWindow(loadedBodies, securityObservations, {
    imageEncodingObservations,
  });
  const token = "p".repeat(43);
  const host = createLocalPagePreviewHost({ BrowserWindow, token });
  try {
    await host.start();
    const endpoint = host.endpoint();
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/preview$/u);
    expect((await fetch(endpoint!, { method: "POST", body: "{}" })).status).toBe(401);

    const response = await fetch(endpoint!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspace_root: workspace,
        entry_path: "dist/index.html",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      entry_path: "dist/index.html",
      viewports: [
        {
          name: "desktop",
          loaded: true,
          blocked_external_requests: 1,
          screenshots: [
            { position: "top", media_type: "image/jpeg" },
            { position: "bottom", media_type: "image/jpeg" },
          ],
        },
        {
          name: "mobile",
          loaded: true,
          blocked_external_requests: 1,
          screenshots: [
            { position: "top", media_type: "image/jpeg" },
            { position: "bottom", media_type: "image/jpeg" },
          ],
        },
      ],
    });
    expect(loadedBodies).toEqual([
      "<main>Preview host</main>",
      "main{display:block}",
      "<main>Preview host</main>",
      "main{display:block}",
    ]);
    expect(securityObservations).toEqual([
      "permission-request-denied",
      "permission-check-denied",
      "download-denied",
      "window-open-denied",
      "external-request-denied",
      "permission-request-denied",
      "permission-check-denied",
      "download-denied",
      "window-open-denied",
      "external-request-denied",
    ]);
    expect(imageEncodingObservations).toEqual([
      {
        sourceSize: { width: 2_880, height: 1_800 },
        resizedTo: { width: 1_440, height: 900, quality: "best" },
        jpegQuality: 68,
      },
      {
        sourceSize: { width: 2_880, height: 1_800 },
        resizedTo: { width: 1_440, height: 900, quality: "best" },
        jpegQuality: 68,
      },
      {
        sourceSize: { width: 780, height: 1_688 },
        resizedTo: { width: 390, height: 844, quality: "best" },
        jpegQuality: 68,
      },
      {
        sourceSize: { width: 780, height: 1_688 },
        resizedTo: { width: 390, height: 844, quality: "best" },
        jpegQuality: 68,
      },
    ]);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron local page preview host blocks sensitive and escaped content fetches", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-preview-sensitive-"));
  const workspace = join(root, "workspace");
  const outsideSecret = join(root, "outside-secret.txt");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, "assets"), { recursive: true });
  writeFileSync(join(workspace, "index.html"), "<main>Safe preview</main>");
  writeFileSync(join(workspace, "assets", "theme.css"), "main{display:block}");
  writeFileSync(join(workspace, "assets", "app.js"), "document.body.dataset.ready='true'");
  writeFileSync(join(workspace, "assets", "site.woff2"), "font-bytes");
  writeFileSync(join(workspace, "assets", "hero.png"), "image-bytes");
  writeFileSync(join(workspace, ".env.local"), "TOKEN=do-not-render");
  writeFileSync(join(workspace, ".git", "config"), "[remote]\nsecret=true");
  writeFileSync(join(workspace, "credentials.json"), '{"token":"do-not-render"}');
  writeFileSync(join(workspace, "assets", "client.pem"), "do-not-render");
  writeFileSync(join(workspace, "assets", "client.key"), "do-not-render");
  writeFileSync(outsideSecret, "outside-do-not-render");
  symlinkSync(outsideSecret, join(workspace, "assets", "escaped.txt"));
  symlinkSync(join(workspace, ".env.local"), join(workspace, "assets", "aliased.css"));

  const contentObservations: ContentFetchObservation[] = [];
  const BrowserWindow = fakeBrowserWindow([], [], {
    contentObservations,
    contentPaths: [
      "assets/theme.css",
      "assets/app.js",
      "assets/site.woff2",
      "assets/hero.png",
      ".env.local",
      ".git/config",
      "credentials.json",
      "assets/client.pem",
      "assets/client.key",
      "assets/aliased.css",
      "assets/escaped.txt",
    ],
  });
  const token = "s".repeat(43);
  const host = createLocalPagePreviewHost({
    BrowserWindow,
    token,
    viewports: [{ name: "desktop", width: 1_440, height: 900, mobile: false }],
  });
  try {
    await host.start();
    const response = await fetch(host.endpoint()!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspace_root: workspace,
        entry_path: "index.html",
      }),
    });
    expect(response.status).toBe(200);
    expect(contentObservations).toEqual([
      { path: "assets/theme.css", status: 200 },
      { path: "assets/app.js", status: 200 },
      { path: "assets/site.woff2", status: 200 },
      { path: "assets/hero.png", status: 200 },
      { path: ".env.local", status: 403 },
      { path: ".git/config", status: 403 },
      { path: "credentials.json", status: 403 },
      { path: "assets/client.pem", status: 403 },
      { path: "assets/client.key", status: 403 },
      { path: "assets/aliased.css", status: 403 },
      { path: "assets/escaped.txt", status: 403 },
    ]);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

interface ContentFetchObservation {
  path: string;
  status: number;
}

interface ImageEncodingObservation {
  sourceSize: { width: number; height: number };
  resizedTo: null | { width: number; height: number; quality: string };
  jpegQuality: number | null;
}

interface FakeBrowserWindowOptions {
  contentObservations?: ContentFetchObservation[];
  contentPaths?: string[];
  imageEncodingObservations?: ImageEncodingObservation[];
}

function fakeBrowserWindow(
  loadedBodies: string[],
  securityObservations: string[],
  options?: FakeBrowserWindowOptions,
) {
  return class FakeBrowserWindow {
    destroyed = false;
    viewport = { width: 0, height: 0 };
    beforeRequest: null | ((
      details: { url: string },
      callback: (decision: { cancel?: boolean; redirectURL?: string }) => void,
    ) => void) = null;
    webContents = {
      session: {
        webRequest: {
          onBeforeRequest: (_filter: unknown, handler?: FakeBrowserWindow["beforeRequest"]) => {
            this.beforeRequest = handler ?? null;
          },
        },
        setPermissionRequestHandler: (handler: (
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void) => {
          handler(null, "camera", (allowed) => {
            if (!allowed) securityObservations.push("permission-request-denied");
          });
        },
        setPermissionCheckHandler: (handler: () => boolean) => {
          if (!handler()) securityObservations.push("permission-check-denied");
        },
        on: (event: string, handler: (event: { preventDefault(): void }) => void) => {
          if (event !== "will-download") return;
          handler({
            preventDefault: () => securityObservations.push("download-denied"),
          });
        },
      },
      capturePage: async () => {
        const sourceSize = {
          width: this.viewport.width * 2,
          height: this.viewport.height * 2,
        };
        const observation: ImageEncodingObservation = {
          sourceSize,
          resizedTo: null,
          jpegQuality: null,
        };
        options?.imageEncodingObservations?.push(observation);
        const encodedImage = {
          toJPEG: (quality: number) => {
            observation.jpegQuality = quality;
            return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
          },
        };
        return {
          getSize: () => sourceSize,
          resize: (resizeOptions: {
            width: number;
            height: number;
            quality: string;
          }) => {
            observation.resizedTo = resizeOptions;
            return encodedImage;
          },
          toJPEG: encodedImage.toJPEG,
        };
      },
      setWindowOpenHandler: (handler: () => { action: string }) => {
        if (handler().action === "deny") securityObservations.push("window-open-denied");
      },
      on: () => undefined,
      executeJavaScript: async (script: string) => script.includes("hiddenTextElements")
        ? {
            bodyTextLength: 12,
            clientWidth: 1_440,
            hiddenTextElements: 0,
            innerWidth: 1_440,
            readyState: "complete",
            scrollHeight: 1_800,
            scrollWidth: 1_440,
          }
        : undefined,
    };

    constructor(input: { width: number; height: number }) {
      this.viewport = { width: input.width, height: input.height };
    }

    async loadURL(url: string) {
      loadedBodies.push(await (await fetch(await this.admittedUrl(url))).text());
      const absoluteAssetUrl = `${new URL(url).origin}/assets/theme.css`;
      loadedBodies.push(
        await (await fetch(await this.admittedUrl(absoluteAssetUrl))).text(),
      );
      for (const path of options?.contentPaths ?? []) {
        const response = await fetch(await this.admittedUrl(new URL(path, url).href));
        options?.contentObservations?.push({ path, status: response.status });
      }
      const external = await this.requestDecision("https://example.com/tracker.js");
      if (external.cancel) securityObservations.push("external-request-denied");
    }

    async admittedUrl(url: string) {
      const decision = await this.requestDecision(url);
      if (decision.cancel) throw new Error(`Unexpected blocked URL: ${url}`);
      return decision.redirectURL ?? url;
    }

    async requestDecision(url: string): Promise<{
      cancel?: boolean;
      redirectURL?: string;
    }> {
      if (!this.beforeRequest) return { cancel: false };
      return await new Promise((resolveDecision) => {
        this.beforeRequest?.({ url }, resolveDecision);
      });
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
    }
  };
}

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerStore } from "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { EMPTY_STEWARD_OBSERVER } from "./support/steward-observer.ts";

const root = process.cwd();

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-app-update-source-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function removeTempRoot(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EBUSY"
    ) {
      // Bun can retain closed SQLite handles until the test process exits on Windows.
      return;
    }
    throw error;
  }
}

function currentAppUpdatePlatformForTest(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `${os}-${arch}`;
}

function appUpdateManifest(input: {
  version: string;
  artifactUrl: string;
  sha256: string;
}): Record<string, unknown> {
  return {
    schema: "butler.update-manifest.v1",
    product: "butler-app",
    app_version: input.version,
    bundled_agent_version: input.version,
    artifacts: [{
      component: "app",
      app_version: input.version,
      version: input.version,
      channel: "stable",
      platform: currentAppUpdatePlatformForTest(),
      artifact_url: input.artifactUrl,
      sha256: input.sha256,
      signature: null,
      bundled_components: ["app"],
      product: "butler-app",
      gateway_profile: "electron",
      bundled_agent_version: input.version,
      protocol_compatibility: {
        protocol: "butler.app.v1",
        minimumAppProtocol: "butler.app.v1",
        maximumAppProtocol: "butler.app.v1",
      },
      integrity: {
        digestAlgorithm: "sha256",
        digest: input.sha256,
        signature: null,
      },
      update_policy: "app-user-action",
      restart_policy: "restart-app",
      updater_owner: "butler-app",
      payload_format: "platform-app-package",
      staging_policy: "platform-updater-cache",
      activation_policy: "platform-app-update-then-versioned-app-runtime",
      rollback_policy: "preserve-previous-app-managed-runtime",
    }],
  };
}

test("packaged App update checks use configured public App update manifest", async () => {
  const workDir = tempRoot();
  const butlerData = join(workDir, "data");
  const manifestPath = join(workDir, "app-update-manifest.json");
  const artifactPath = join(workDir, "butler-app-0.0.13.pkg");
  const artifactBytes = "butler app update payload\n";
  const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
  writeFileSync(artifactPath, artifactBytes, "utf8");
  writeFileSync(
    manifestPath,
    JSON.stringify(appUpdateManifest({
      version: "0.0.13",
      artifactUrl: artifactPath,
      sha256,
    })),
    "utf8",
  );

  const store = new AppServerStore({
    butlerData,
    butlerHome: root,
    appVersion: "0.0.12",
    appUpdateManifest: manifestPath,
    dbPath: join(workDir, "app.sqlite"),
    stewardObserver: EMPTY_STEWARD_OBSERVER,
  });
  try {
    const view = await store.getUpdateStatus();
    expect(view.manifest_source).toBe(manifestPath);
    expect(view.components).toHaveLength(1);
    expect(view.components[0]).toMatchObject({
      component: "app",
      current_version: "0.0.12",
      available_version: "0.0.13",
      update_available: true,
      bundled_agent_version: "0.0.13",
      manifest_source: manifestPath,
    });
  } finally {
    store.close();
    removeTempRoot(workDir);
  }
});

test("packaged App update checks default to the public latest App manifest", async () => {
  const workDir = tempRoot();
  const originalFetch = globalThis.fetch;
  const previousAppManifest = process.env.BUTLER_APP_UPDATE_MANIFEST;
  const previousManifest = process.env.BUTLER_UPDATE_MANIFEST;
  let requestedUrl = "";
  try {
    delete process.env.BUTLER_APP_UPDATE_MANIFEST;
    delete process.env.BUTLER_UPDATE_MANIFEST;
    const sha256 = createHash("sha256").update("remote app artifact\n").digest("hex");
    globalThis.fetch = (async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(appUpdateManifest({
        version: "0.0.13",
        artifactUrl: "https://example.test/butler-app-0.0.13.pkg",
        sha256,
      })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const store = new AppServerStore({
      butlerData: join(workDir, "data"),
      butlerHome: root,
      appVersion: "0.0.12",
      dbPath: join(workDir, "app.sqlite"),
      stewardObserver: EMPTY_STEWARD_OBSERVER,
    });
    try {
      const view = await store.getUpdateStatus();
      expect(requestedUrl).toBe(
        "https://github.com/Hexpy-Games/butler/releases/latest/download/app-update-manifest.json",
      );
      expect(view.manifest_source).toBe(requestedUrl);
      expect(view.components[0]).toMatchObject({
        current_version: "0.0.12",
        available_version: "0.0.13",
        update_available: true,
      });
    } finally {
      store.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAppManifest === undefined) {
      delete process.env.BUTLER_APP_UPDATE_MANIFEST;
    } else {
      process.env.BUTLER_APP_UPDATE_MANIFEST = previousAppManifest;
    }
    if (previousManifest === undefined) {
      delete process.env.BUTLER_UPDATE_MANIFEST;
    } else {
      process.env.BUTLER_UPDATE_MANIFEST = previousManifest;
    }
    removeTempRoot(workDir);
  }
});

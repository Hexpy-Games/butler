import { stageElectronPackageSource } from "../../packages/butler-app/scripts/release/electron-package-source.ts";
import { afterEach, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  closureFromNativeMacBundle,
  createNativeMacReleaseManifest,
  nativeMacDependencyClosure,
  sha256Tree,
  validateNativeMacReleaseManifest,
  verifyNativeMacBundle,
} from "../../packages/butler-app/scripts/release/native-mac-manifest.ts";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

// test-category: format-pin
test("native mac release validates inputs and stages the runtime shell", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-native-mac-gate-"));
  roots.push(root);
  const packageDir = join(root, "packages", "butler-app", "client", "electron");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(root, "VERSION"), "9.8.7");
  const manifest = createNativeMacReleaseManifest(root);
  expect(manifest.version).toBe("1.2.3-dev");
  expect(manifest.bundledAgentVersion).toBe("9.8.7-dev");
  expect(validateNativeMacReleaseManifest(root, manifest)).toContain(
    "native mac release input missing: packages/butler-app/client/electron/main.mjs",
  );
  // Stage the runtime shell from an installed Bun workspace without copying
  // development symlinks that Electron's npm-oriented pruner cannot traverse.
  for (const name of ["node_modules", "dist", ".native-agent-payload", "assets"]) {
    mkdirSync(join(packageDir, name));
    writeFileSync(join(packageDir, name, "fixture"), name);
  }
  writeFileSync(join(packageDir, "main.mjs"), "import { app } from 'electron';");
  const staged = stageElectronPackageSource(root, join(root, "electron-source"));
  expect(readFileSync(join(staged, "main.mjs"), "utf8")).toBe("import { app } from 'electron';");
  expect(readFileSync(join(staged, "assets/fixture"), "utf8")).toBe("assets");
  for (const name of ["node_modules", "dist", ".native-agent-payload"]) {
    expect(existsSync(join(staged, name))).toBe(false);
  }
  const previousTag = process.env.GITHUB_REF_NAME;
  try {
    process.env.GITHUB_REF_NAME = "v0.1.0-preview.99";
    const preview = createNativeMacReleaseManifest(root);
    expect(preview.version).toBe("0.1.0-preview.99");
    expect(preview.bundledAgentVersion).toBe("0.1.0-preview.99");
    const previewSource = stageElectronPackageSource(root, join(root, "preview-source"));
    expect(JSON.parse(readFileSync(join(previewSource, "package.json"), "utf8")).version)
      .toBe("0.1.0-preview.99");
  } finally {
    if (previousTag === undefined) delete process.env.GITHUB_REF_NAME;
    else process.env.GITHUB_REF_NAME = previousTag;
  }
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ dependencies: { unexpected: "1" } }));
  expect(() => stageElectronPackageSource(root, join(root, "invalid-source"))).toThrow(
    "Electron runtime dependencies require an inventoried packaging layout",
  );
});

test("native mac bundle closure follows binary, resources, manifest and App renderer", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-native-mac-bundle-"));
  roots.push(root);
  const app = join(root, "Butler.app");
  const resources = join(app, "Contents", "Resources");
  const payload = join(resources, "bundled-agent");
  const binary = join(payload, "bin", "butler-agent");
  const agentResources = join(payload, "resources");
  const renderer = join(resources, "app-client");
  mkdirSync(join(payload, "bin"), { recursive: true });
  mkdirSync(agentResources);
  mkdirSync(renderer);
  writeFileSync(binary, "native-agent");
  chmodSync(binary, 0o555);
  writeFileSync(join(agentResources, "default.json"), "{}");
  writeFileSync(join(renderer, "index.html"), "<main>Butler</main>");
  const payloadManifest = join(payload, "native-agent-manifest.json");
  writeFileSync(payloadManifest, JSON.stringify({
    schema: "butler.native-agent-payload.v1", version: "0.0.21", appVersion: "1.2.3",
    platform: "darwin", architecture: "arm64", binary: "bin/butler-agent", resources: "resources",
  }));
  chmodSync(payloadManifest, 0o444);
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const release = { version: "1.2.3", bundledAgentVersion: "0.0.21" };
  const closure = closureFromNativeMacBundle(app, release);
  expect(closure.version).toBe(release.bundledAgentVersion);
  expect(closure).toEqual(nativeMacDependencyClosure({
    version: "0.0.21", appVersion: "1.2.3", binarySha256: hash(binary),
    resourcesSha256: sha256Tree(agentResources), payloadManifestSha256: hash(payloadManifest),
    rendererSha256: sha256Tree(renderer),
  }));
  verifyNativeMacBundle(app, closure);
  expect(() => verifyNativeMacBundle(app, {
    ...closure, binary: { ...closure.binary, path: "../outside" as typeof closure.binary.path },
  })).toThrow("native mac dependency closure is invalid");
  writeFileSync(join(renderer, "index.html"), "<main>tampered</main>");
  expect(() => verifyNativeMacBundle(app, closure)).toThrow("native mac bundle directory mismatch: app-client");
});

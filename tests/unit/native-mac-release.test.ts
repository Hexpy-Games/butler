import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("native mac release gate rejects missing real package input", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-native-mac-gate-"));
  roots.push(root);
  const packageDir = join(root, "packages", "butler-app", "client", "electron");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(root, "VERSION"), "9.8.7");
  const manifest = createNativeMacReleaseManifest(root);
  expect(manifest.version).toBe("1.2.3");
  expect(manifest.bundledAgentVersion).toBe("9.8.7");
  expect(validateNativeMacReleaseManifest(root, manifest)).toContain(
    "native mac release input missing: packages/butler-app/client/electron/main.mjs",
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

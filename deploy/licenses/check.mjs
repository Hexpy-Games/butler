import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyRendererModules } from "./verify-renderer.mjs";
import { generate, root, validateLicense, productionPackages, verifyProductionInventory } from "./generate.mjs";

// test-category: pure-logic
const first = generate();
assert.equal(generate(), first, "same locked inputs must produce identical bytes");
assert.equal(readFileSync(join(root, "deploy/licenses/THIRD_PARTY_NOTICES.txt"), "utf8"), first);
const fixture = JSON.parse(readFileSync(join(root, "deploy/licenses/fixtures/unknown.json"), "utf8"));
assert.throws(() => validateLicense(fixture), /outside allowlist/, "unknown license must fail CI");
assert.throws(() => validateLicense({ id: "fixture:unknown-choice", license: "MIT OR LicenseRef-Unknown" }), /outside allowlist/);
const catalog = JSON.parse(readFileSync(join(root, "deploy/licenses/catalog.json"), "utf8"));
assert.equal(first.split("\n===== COMPONENT =====\n").length - 1, catalog.components.length);
assert.ok(!catalog.texts, "no license text store");
for (const component of catalog.components) {
  assert.ok(first.includes(`${component.name} ${component.version}\n${component.license}\n`));
  for (const link of component.links) assert.ok(first.includes(`License: ${link}`));
  for (const line of component.copyright) assert.ok(first.includes(line));
}
const original = catalog.components[0];
assert.ok(!first.includes("Permission is hereby granted"), "full license bodies must not ship");
assert.ok(Buffer.byteLength(first) <= 300_000, "complete disclosure size budget");
catalog.components[0] = { ...original, links: [] };
assert.throws(() => generate(catalog), /Missing or invalid license link/);
catalog.components[0] = { ...original, links: ["javascript:invalid"] };
assert.throws(() => generate(catalog), /Missing or invalid license link/);
catalog.components[0] = { ...original, license: fixture.license };
assert.throws(() => generate(catalog), /outside allowlist/, "build pipeline must reject unknown fixture");
assert.throws(() => validateLicense({ id: "fixture:missing", license: null }), /Unknown license/);
assert.throws(() => validateLicense({ id: "fixture:copyleft", license: "MPL-2.0" }), /outside allowlist/);
assert.throws(() => validateLicense({ id: "fixture:and", license: "MIT AND GPL-3.0-only" }), /outside allowlist/);
validateLicense({ id: "fixture:choice", license: "MIT OR GPL-3.0-only" });
catalog.components[0] = original;
const model = catalog.components.find((entry) => entry.id.startsWith("model:Xenova/bge-m3"));
model.version = "mismatched-revision";
assert.throws(() => generate(catalog), /Embedding download revision differs/);
console.log("Notices determinism, missing/unknown license, links, model identity, AND/OR and new copyleft checks passed");

// test-category: pure-logic
const lock = {
  workspaces: {
    "packages/butler-app/client/ui": { name: "ui", dependencies: { renderer: "1" } },
    "packages/butler-app/client/electron": { name: "electron-client" },
  },
  packages: {
    "ui/renderer": ["renderer@1", "", { dependencies: { "@scope/child": "1" },
      optionalDependencies: { "native-linux": "1", "native-darwin": "1" } }, "renderer-hash"],
    "ui/renderer/@scope/child": ["@scope/child@1", "", { dependencies: { leaf: "2" },
      peerDependencies: { absent: "1" }, optionalPeers: ["absent"] }, "child-hash"],
    "ui/renderer/leaf": ["leaf@2", "", {}, "leaf-hash"],
    "native-linux": ["native-linux@1", "", { os: "linux", cpu: "arm64" }, "linux-hash"],
    "native-darwin": ["native-darwin@1", "", { os: "darwin", cpu: "arm64" }, "darwin-hash"],
    electron: ["electron@1", "", {}, "electron-hash"],
  },
};
const packages = productionPackages(lock);
assert.deepEqual(packages.map(({ identity }) => identity), [
  "@scope/child@1", "electron@1", "leaf@2", "native-darwin@1", "native-linux@1", "renderer@1",
]);
const evidence = { components: packages.map(({ identity, integrity }) => ({ id: `npm:${identity}`, integrity })) };
assert.equal(verifyProductionInventory(evidence, lock), 6);
evidence.components = evidence.components.filter(({ id }) => id !== "npm:native-linux@1");
assert.throws(() => verifyProductionInventory(evidence, lock), /Missing locked license evidence: native-linux@1/);
const directory = mkdtempSync(join(tmpdir(), "butler-renderer-inventory-"));
try {
  const path = join(directory, "node_modules/react");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "react", version: "19.2.6" }));
  const modules = [join(path, "index.js")];
  // Restore the real catalog after the earlier mutation tests.
  const realCatalog = JSON.parse(readFileSync(join(root, "deploy/licenses/catalog.json"), "utf8"));
  assert.equal(verifyRendererModules(modules, realCatalog), 1);
  assert.throws(() => verifyRendererModules(modules, { components: [] }), /not inventoried: react@19.2.6/);
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "react", version: "19.2.5" }));
  assert.throws(() => verifyRendererModules(modules, realCatalog), /not inventoried: react@19.2.5/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("Locked workspace, scoped ancestry, optional-platform union and shipped-module coverage passed");

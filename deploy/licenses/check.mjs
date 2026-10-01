import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate, root, validateLicense } from "./generate.mjs";

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

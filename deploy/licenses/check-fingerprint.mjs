import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { root, inputFiles, modelInputs, noticeDirectories, refreshCommand } from "./inputs.mjs";

// test-category: pure-logic
// Exercise the actual generation/check CLI against isolated repository inputs.
const temporary = mkdtempSync(join(tmpdir(), "butler-notices-fingerprint-"));
const put = (file, content) => {
  mkdirSync(dirname(join(temporary, file)), { recursive: true });
  writeFileSync(join(temporary, file), content);
};
const run = () => spawnSync(process.execPath, ["deploy/licenses/generate.mjs", "--check"],
  { cwd: temporary, encoding: "utf8" });
const passes = () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
};
const stale = (file) => {
  const result = run();
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`Notices inventory is stale: ${file}; run ${refreshCommand}`), result.stderr);
};
try {
  for (const directory of noticeDirectories) mkdirSync(join(temporary, directory), { recursive: true });
  for (const file of [...inputFiles(), "deploy/licenses/catalog.json", "deploy/licenses/THIRD_PARTY_NOTICES.txt"]) {
    mkdirSync(dirname(join(temporary, file)), { recursive: true });
    cpSync(join(root, file), join(temporary, file));
  }
  passes();
  for (const [file, names] of Object.entries(modelInputs)) {
    const original = readFileSync(join(temporary, file), "utf8");
    put(file, `// const ${names[0]}: &str = "ignored";\n${original}\n/* outer /* nested */ const ${names[0]}: &str = "ignored"; */\n`);
    passes();
    for (const name of names) {
      put(file, original.replace(new RegExp(`(const ${name}: &str = ")[^"]+`), "$1changed-identity"));
      stale(file);
    }
    put(file, original.replace(`const ${names[0]}:`, "const REMOVED_IDENTITY:"));
    stale(file);
    put(file, original);
  }
  // Rust code and first-party resources previously swept up by directory hashing.
  put("packages/butler-agent/rust/crates/butler-core/src/js_date/parse/iso.rs", "// comment-only change\n");
  put("packages/butler-agent/resources/prompts/worker.md", "First-party prompt edit\n");
  passes();
  for (const file of ["bun.lock", "packages/butler-agent/rust/Cargo.lock"]) {
    const original = readFileSync(join(temporary, file), "utf8");
    const bumped = original.replace(/(version = "|@)(\d+)\./, (_, prefix, major) => `${prefix}${Number(major) + 1}.`);
    assert.notEqual(bumped, original, "fixture must bump a dependency version");
    put(file, bumped);
    stale(file);
    put(file, original);
  }
  for (const file of ["deploy/licenses/generate.mjs", "packages/butler-npm/package.json",
    "packages/butler-agent/rust/crates/butler-core/src/js_date/parse/LICENSE.txt"]) {
    const original = readFileSync(join(temporary, file), "utf8");
    put(file, file.endsWith("package.json") ? original.replace('"name":', '"changed": true, "name":') : `${original}\n`);
    stale(file);
    put(file, original);
  }
  const added = "packages/butler-agent/resources/NOTICE.txt";
  put(added, "New third-party notice\n");
  stale(added);
  rmSync(join(temporary, added));
  const notice = "packages/butler-agent/rust/crates/butler-core/src/js_date/parse/LICENSE.txt";
  rmSync(join(temporary, notice));
  stale(notice);
  cpSync(join(root, notice), join(temporary, notice));
  const catalog = JSON.parse(readFileSync(join(temporary, "deploy/licenses/catalog.json"), "utf8"));
  catalog.components[0].license = "LicenseRef-Unknown";
  put("deploy/licenses/catalog.json", JSON.stringify(catalog));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /License outside allowlist: .*LicenseRef-Unknown/);
  console.log("CLI fingerprints: comment-only edits pass; dependency/model/manifest/notice/generator changes and unknown licenses fail");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

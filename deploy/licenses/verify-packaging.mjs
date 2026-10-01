import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { generate, root } from "./generate.mjs";
import { finalizeAppNotices } from "./package-app.mjs";
import { createAppRendererProtocolHandler } from "../../packages/butler-app/client/electron/app-renderer-protocol.mjs";

// Offline packaging smoke: real finalizer, Agent archive writer and npm pack.
const temporary = mkdtempSync(join(tmpdir(), "butler-disclosure-package-"));
const document = generate();
const data = gzipSync(document, { level: 9 });
const old = execFileSync("git", ["show", "c86339558:deploy/licenses/THIRD_PARTY_NOTICES.txt"], { cwd: root, maxBuffer: 20_000_000 });
const put = (path, content) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
try {
  for (const platform of ["linux", "mac"]) {
    const app = join(temporary, platform);
    const resources = join(app, platform === "mac" ? "Contents/Resources" : "resources");
    const canonical = join(resources, "bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz");
    put(canonical, data);
    put(join(resources, "app-client/index.html"), "<html></html>");
    put(join(resources, "app-client/THIRD_PARTY_NOTICES.txt.gz"), data);
    put(join(resources, "bundled-agent/bin/THIRD_PARTY_NOTICES.txt"), old);
    finalizeAppNotices(app);
    assert.ok(!existsSync(join(resources, "app-client/THIRD_PARTY_NOTICES.txt.gz")));
    assert.ok(!existsSync(join(resources, "bundled-agent/bin/THIRD_PARTY_NOTICES.txt")));
    const handle = createAppRendererProtocolHandler({ distRoot: join(resources, "app-client"), noticesFile: canonical });
    const response = await handle(new Request("app://butler/THIRD_PARTY_NOTICES.txt.gz"));
    assert.equal(response.status, 200);
    assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), document);
    const pointer = readFileSync(join(resources, "THIRD_PARTY_NOTICES.txt"));
    assert.ok(data.length + pointer.length <= 300_000);
    console.log(`${platform} App resource delta: ${old.length * 3} -> ${data.length + pointer.length} bytes`);
  }
  const payload = join(temporary, "payload");
  put(join(payload, "resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz"), data);
  mkdirSync(join(payload, "bin"));
  put(join(payload, "bin/butler-agent"), readFileSync("/usr/bin/true"));
  put(join(payload, "native-agent-manifest.json"), JSON.stringify({ schema: "butler.native-agent-payload.v1",
    version: "0.0.21", platform: "linux", architecture: "x64", binary: "bin/butler-agent", resources: "resources" }));
  const archive = join(temporary, "agent.tar.gz");
  execFileSync("python3", [join(root, "packages/butler-agent/rust/scripts/package-standalone-agent.py"), "--payload", payload, "--output", archive]);
  const member = "resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz";
  assert.equal(gunzipSync(execFileSync("tar", ["-xOzf", archive, member])).toString(), document);
  const pointer = execFileSync("tar", ["-xOzf", archive, "THIRD_PARTY_NOTICES.txt"]);
  assert.ok(pointer.toString().includes("gzip -dc"));
  assert.ok(data.length + pointer.length <= 200_000);
  console.log(`Agent notice payload: ${old.length * 2} -> ${data.length + pointer.length} bytes`);
  const archiveStage = join(temporary, "archive-stage");
  mkdirSync(archiveStage);
  execFileSync("tar", ["-xzf", archive, "-C", archiveStage]);
  rmSync(join(archiveStage, "resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz"));
  put(join(archiveStage, "resources/app-client/dist/THIRD_PARTY_NOTICES.txt"), old);
  rmSync(join(archiveStage, "THIRD_PARTY_NOTICES.txt"));
  put(join(archiveStage, "THIRD_PARTY_NOTICES.txt"), old);
  const oldArchive = join(temporary, "old-agent.tar.gz");
  execFileSync("python3", ["-c", `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("pack",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.write_deterministic_archive(Path(sys.argv[2]),Path(sys.argv[3]))`,
  join(root, "packages/butler-agent/rust/scripts/package-standalone-agent.py"), archiveStage, oldArchive]);
  console.log(`Agent fixture tarball (same ELF binary): ${readFileSync(oldArchive).length} -> ${readFileSync(archive).length} bytes`);
  const npm = join(temporary, "npm");
  cpSync(join(root, "packages/butler-npm"), npm, { recursive: true });
  // Prepack uses the repository generator; npm packs only the installer closure.
  execFileSync("node", [join(root, "packages/butler-npm/scripts/copy-install-script.js")]);
  for (const file of ["install.sh", "THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt.gz"]) cpSync(join(root, "packages/butler-npm", file), join(npm, file));
  const pack = () => JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: npm }))[0];
  const current = pack();
  const npmNotices = execFileSync("tar", ["-xOzf", join(temporary, current.filename), "package/THIRD_PARTY_NOTICES.txt.gz"]);
  assert.equal(gunzipSync(npmNotices).toString(), document);
  rmSync(join(npm, "THIRD_PARTY_NOTICES.txt.gz"));
  writeFileSync(join(npm, "THIRD_PARTY_NOTICES.txt"), old);
  const baseline = pack();
  assert.ok(current.size <= 200_000);
  console.log(`npm tarball (same installer): ${baseline.size} -> ${current.size} bytes; unpacked notices ${data.length + readFileSync(join(root, "packages/butler-npm/THIRD_PARTY_NOTICES.txt")).length}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

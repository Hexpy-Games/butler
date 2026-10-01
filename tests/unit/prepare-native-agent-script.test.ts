import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { legacyProcessRoleFileNames, processRoleFileNames } from "../../packages/butler-app/client/electron/scripts/process-role-names.mjs";

const script = resolve("packages/butler-app/client/electron/scripts/prepare-native-agent.mjs");
// The producer only runs on its supported host; the fixture agent implements
// role-link preparation and a stub otool accepts its executable payload.
const supportedHost = process.platform === "darwin" && process.arch === "arm64";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "butler-prepare-native-agent-")));
  roots.push(root);
  const tools = join(root, "tools");
  const ui = join(root, "ui");
  const target = join(root, "target");
  const calls = join(root, "calls.log");
  mkdirSync(tools);
  mkdirSync(ui);
  const fakeAgent = join(root, "fake-agent");
  writeFileSync(
    fakeAgent,
    '#!/bin/sh\nif [ "$1" = "--prepare-process-links" ]; then\n  dir=$(dirname "$0")\n' +
      '  for role in memory restart update; do ln "$0" "$dir/butler-agent (' +
      '$role)"; done\n  exit 0\nfi\nexit 0\n',
  );
  chmodSync(fakeAgent, 0o755);
  writeFileSync(join(ui, "index.html"), "<main>Butler</main>");
  writeFileSync(join(ui, "THIRD_PARTY_NOTICES.txt.gz"), gzipSync(readFileSync("deploy/licenses/THIRD_PARTY_NOTICES.txt")));
  const stub = (name: string, body: string) => {
    writeFileSync(join(tools, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(tools, name), 0o755);
  };
  stub("cargo", `mkdir -p "${target}/release" && cp "$BUTLER_NATIVE_AGENT_FIXTURE" "${target}/release/butler-agent"`);
  writeFileSync(join(tools, "otool"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(tools, "otool"), 0o755);
  stub("python3", "echo '{\"ort_lib_path\":\"/stub/ort\",\"protoc\":\"/stub/protoc\"}'");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHON3: join(tools, "python3"),
    CARGO_TARGET_DIR: target,
    BUTLER_NATIVE_AGENT_FIXTURE: fakeAgent,
    BUTLER_NATIVE_UI_DIST: ui,
    BUTLER_NATIVE_PAYLOAD_WRITABLE: "1",
  };
  delete env.BUTLER_NATIVE_AGENT_EXECUTABLE;
  const payload = join(root, "payload");
  const prepare = (extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("node", [script, "darwin", "arm64", payload], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { root, payload, prepare, log };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectPayload(payload: string, source: string, stdout: string) {
  const sha = sha256(source);
  expect(sha256(join(payload, "bin", "butler-agent"))).toBe(sha);
  expect(existsSync(join(payload, "resources", "app-client", "dist", "index.html"))).toBe(true);
  const notices = join(payload, "resources", "app-client", "dist", "THIRD_PARTY_NOTICES.txt.gz");
  expect(gunzipSync(readFileSync(notices))).toEqual(readFileSync("deploy/licenses/THIRD_PARTY_NOTICES.txt"));
  const manifest = JSON.parse(readFileSync(join(payload, "native-agent-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({
    schema: "butler.native-agent-payload.v1",
    binary: "bin/butler-agent",
    resources: "resources",
  });
  for (const role of ["memory", "restart", "update"]) {
    const alias = join(payload, "bin", `butler-agent (${role})`);
    const binary = join(payload, "bin", "butler-agent");
    expect(existsSync(alias)).toBe(true);
    expect(sha256(alias)).toBe(sha);
    expect(statSync(alias).ino).toBe(statSync(binary).ino);
    expect(statSync(alias).mode & 0o111).not.toBe(0);
  }
  expect(stdout).toContain(`Native Butler Agent binary sha256: ${sha}`);
}

// test-category: pure-logic
test("process role filenames follow each platform's display contract", () => {
  expect(processRoleFileNames("darwin")).toEqual([
    "butler-agent (memory)", "butler-agent (restart)", "butler-agent (update)",
  ]);
  expect(processRoleFileNames("win32")).toEqual([
    "butler-agent (memory).exe", "butler-agent (restart).exe", "butler-agent (update).exe",
  ]);
  expect(processRoleFileNames("linux")).toEqual([
    "butler-memory", "butler-restart", "butler-update",
  ]);
  expect(legacyProcessRoleFileNames()).toEqual([
    "butler(memory)", "butler(restart)", "butler(update)",
  ]);
});

// test-category: format-pin
test.skipIf(!supportedHost)("prepare-native-agent builds from source by default", () => {
  const { root, payload, prepare, log } = fixture();
  const result = prepare();
  expect(result.status, result.stderr).toBe(0);
  expect(log()).toContain("cargo build --release --locked -p butler-agent");
  expect(result.stdout).toContain("(built from source)");
  expectPayload(payload, join(root, "target", "release", "butler-agent"), result.stdout);
});

// test-category: format-pin
test.skipIf(!supportedHost)("prepare-native-agent lays out a supplied prebuilt binary without building", () => {
  const { root, payload, prepare, log } = fixture();
  const prebuilt = join(root, "prebuilt-agent");
  copyFileSync(join(root, "fake-agent"), prebuilt);
  chmodSync(prebuilt, 0o755);
  const result = prepare({ BUTLER_NATIVE_AGENT_EXECUTABLE: prebuilt });
  expect(result.status, result.stderr).toBe(0);
  expect(log()).toBe("");
  expect(result.stdout).toContain(`(prebuilt, cargo build skipped): ${prebuilt}`);
  expectPayload(payload, prebuilt, result.stdout);
});

// test-category: format-pin
test.skipIf(!supportedHost)("prepare-native-agent rejects a supplied binary that is not executable", () => {
  const { root, prepare, log } = fixture();
  const prebuilt = join(root, "prebuilt-agent");
  writeFileSync(prebuilt, "not executable");
  chmodSync(prebuilt, 0o644);
  const result = prepare({ BUTLER_NATIVE_AGENT_EXECUTABLE: prebuilt });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("BUTLER_NATIVE_AGENT_EXECUTABLE is not executable");
  expect(log()).toBe("");
});

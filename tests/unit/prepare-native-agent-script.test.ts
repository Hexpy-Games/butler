import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("packages/butler-app/client/electron/scripts/prepare-native-agent.mjs");
// The producer only runs on its supported host; /usr/bin/true stands in for the
// agent because it passes the otool dependency-closure check.
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
  writeFileSync(join(ui, "index.html"), "<main>Butler</main>");
  const stub = (name: string, body: string) => {
    writeFileSync(join(tools, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(tools, name), 0o755);
  };
  stub("cargo", `mkdir -p "${target}/release" && cp /usr/bin/true "${target}/release/butler-agent"`);
  stub("python3", "echo '{\"ort_lib_path\":\"/stub/ort\",\"protoc\":\"/stub/protoc\"}'");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHON3: join(tools, "python3"),
    CARGO_TARGET_DIR: target,
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
  const manifest = JSON.parse(readFileSync(join(payload, "native-agent-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({
    schema: "butler.native-agent-payload.v1",
    binary: "bin/butler-agent",
    resources: "resources",
  });
  expect(stdout).toContain(`Native Butler Agent binary sha256: ${sha}`);
}

test.skipIf(!supportedHost)("prepare-native-agent builds from source by default", () => {
  const { root, payload, prepare, log } = fixture();
  const result = prepare();
  expect(result.status, result.stderr).toBe(0);
  expect(log()).toContain("cargo build --release --locked -p butler-agent");
  expect(result.stdout).toContain("(built from source)");
  expectPayload(payload, join(root, "target", "release", "butler-agent"), result.stdout);
});

test.skipIf(!supportedHost)("prepare-native-agent lays out a supplied prebuilt binary without building", () => {
  const { root, payload, prepare, log } = fixture();
  const prebuilt = join(root, "prebuilt-agent");
  copyFileSync("/usr/bin/true", prebuilt);
  chmodSync(prebuilt, 0o755);
  const result = prepare({ BUTLER_NATIVE_AGENT_EXECUTABLE: prebuilt });
  expect(result.status, result.stderr).toBe(0);
  expect(log()).toBe("");
  expect(result.stdout).toContain(`(prebuilt, cargo build skipped): ${prebuilt}`);
  expectPayload(payload, prebuilt, result.stdout);
});

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

#!/usr/bin/env node
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requestedPlatform = process.argv[2] ?? process.platform;
const requestedArch = process.argv[3] ?? process.arch;
const explicitPayloadRoot = process.argv[4] ? resolve(process.argv[4]) : null;
// Each supported payload maps to the static ONNX Runtime recipe target that
// builds it (prepare-static-ort.py). Builds are native only.
const ORT_TARGETS = {
  "darwin/arm64": "macos-arm64",
  "linux/x64": "linux-x64",
  "linux/arm64": "linux-arm64",
};
// The glibc-family libraries every supported distribution ships. Anything
// else (an ORT shared library above all) would be missing from the package.
const LINUX_SYSTEM_LIBRARIES = new Set([
  "libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1",
  "libgcc_s.so.1", "libstdc++.so.6", "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1",
]);
const LINUX_ELF_MACHINES = { x64: "Advanced Micro Devices X86-64", arm64: "AArch64" };

const ortTarget = ORT_TARGETS[`${requestedPlatform}/${requestedArch}`];
if (!ortTarget) {
  throw new Error(
    `Native Butler Agent static packaging supports ${Object.keys(ORT_TARGETS).join(", ")}; requested ${requestedPlatform}/${requestedArch}.`,
  );
}
if (requestedPlatform !== process.platform || requestedArch !== process.arch) {
  throw new Error(
    `Native Butler Agent cross packaging is unavailable: requested ${requestedPlatform}/${requestedArch}, host ${process.platform}/${process.arch}.`,
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(electronRoot, "../../../..");
const rustRoot = join(repositoryRoot, "packages", "butler-agent", "rust");

const payloadRoot = explicitPayloadRoot ??
  join(electronRoot, ".native-agent-payload", "bundled-agent");
const prebuiltBinary = resolvePrebuiltBinary(process.env.BUTLER_NATIVE_AGENT_EXECUTABLE, payloadRoot);
const sourceBinary = prebuiltBinary ?? buildNativeAgent();
if (requestedPlatform === "darwin") verifyMacDependencyClosure(sourceBinary);
if (requestedPlatform === "linux") verifyLinuxDependencyClosure(sourceBinary, requestedArch);
const sourceSha256 = createHash("sha256").update(readFileSync(sourceBinary)).digest("hex");
process.stdout.write(
  `Native Butler Agent binary (${prebuiltBinary ? "prebuilt, cargo build skipped" : "built from source"}): ${sourceBinary}\n` +
    `Native Butler Agent binary sha256: ${sourceSha256}\n`,
);

makeWritable(payloadRoot);
rmSync(payloadRoot, { recursive: true, force: true });
const binaryRoot = join(payloadRoot, "bin");
mkdirSync(binaryRoot, { recursive: true });
copyFileSync(sourceBinary, join(binaryRoot, "butler-agent"));
const roleLinks = spawnSync(join(binaryRoot, "butler-agent"), ["--prepare-process-links"], { stdio: "inherit" });
if (roleLinks.status !== 0 && roleLinks.status !== 2) throw new Error("Could not prepare Agent process role links.");
cpSync(
  join(repositoryRoot, "packages", "butler-agent", "resources"),
  join(payloadRoot, "resources"),
  { recursive: true },
);
const uiDistRoot = resolve(
  process.env.BUTLER_NATIVE_UI_DIST ||
    join(repositoryRoot, "packages", "butler-app", "client", "ui", "dist"),
);
requireFile(join(uiDistRoot, "index.html"));
requireFile(join(uiDistRoot, "THIRD_PARTY_NOTICES.txt.gz"));
if (!gunzipSync(readFileSync(join(uiDistRoot, "THIRD_PARTY_NOTICES.txt.gz"))).equals(readFileSync(join(repositoryRoot, "deploy/licenses/THIRD_PARTY_NOTICES.txt")))) {
  throw new Error("Renderer notices are stale; rebuild the App renderer.");
}
cpSync(uiDistRoot, join(payloadRoot, "resources", "app-client", "dist"), { recursive: true });
const version = readCargoVersion(join(rustRoot, "crates", "butler-agent", "Cargo.toml"));
const appVersion = process.env.BUTLER_PACKAGED_APP_VERSION?.trim() ||
  JSON.parse(readFileSync(join(electronRoot, "package.json"), "utf8")).version?.trim();
if (!appVersion) throw new Error("Packaged App version is required for the native Agent payload.");
writeFileSync(
  join(payloadRoot, "native-agent-manifest.json"),
  `${JSON.stringify({
    schema: "butler.native-agent-payload.v1",
    version,
    appVersion,
    platform: requestedPlatform,
    architecture: requestedArch,
    binary: "bin/butler-agent",
    resources: "resources",
  }, null, 2)}\n`,
);
if (process.env.BUTLER_NATIVE_PAYLOAD_WRITABLE !== "1") setReadOnly(payloadRoot);
process.stdout.write(`Native Butler Agent payload prepared: ${payloadRoot}\n`);

/**
 * A prebuilt agent supplied through BUTLER_NATIVE_AGENT_EXECUTABLE replaces the
 * cargo build; the payload is laid out from it the same way. Unset keeps the
 * build-from-source default.
 */
function resolvePrebuiltBinary(configured, payload) {
  const value = configured?.trim();
  if (!value) return null;
  const binary = resolve(value);
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error(`BUTLER_NATIVE_AGENT_EXECUTABLE is not an existing file: ${binary}`);
  }
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    throw new Error(`BUTLER_NATIVE_AGENT_EXECUTABLE is not executable: ${binary}`);
  }
  const real = realpathSync(binary);
  const inside = relative(existsSync(payload) ? realpathSync(payload) : resolve(payload), real);
  if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    throw new Error(`BUTLER_NATIVE_AGENT_EXECUTABLE is inside the payload being replaced: ${real}`);
  }
  return real;
}

function buildNativeAgent() {
  const prepareScript = join(rustRoot, "scripts", "prepare-static-ort.py");
  const prepared = JSON.parse(run(process.env.PYTHON3 || "python3", [prepareScript, "--target", ortTarget], rustRoot));
  if (!prepared.ort_lib_path || !prepared.protoc) {
    throw new Error("Static ONNX Runtime preparation returned incomplete build paths.");
  }
  const buildEnv = { ...process.env };
  for (const inheritedOrtSetting of [
    "ORT_STRATEGY", "ORT_LIB_LOCATION", "ORT_LIB_PROFILE", "ORT_INCLUDE_PATH",
    "ORT_PREFER_DYNAMIC_LINK", "ORT_SKIP_DOWNLOAD", "ORT_OFFLINE",
  ]) {
    delete buildEnv[inheritedOrtSetting];
  }
  Object.assign(buildEnv, {
    ORT_LIB_PATH: prepared.ort_lib_path,
    ORT_PREFER_DYNAMIC_LINK: "0",
    ORT_SKIP_DOWNLOAD: "1",
    PROTOC: prepared.protoc,
  });
  run("cargo", [
    "build", "--release", "--locked", "-p", "butler-agent",
    "--no-default-features", "--features", "static-ort",
  ], rustRoot, buildEnv);
  const targetRoot = process.env.CARGO_TARGET_DIR
    ? resolve(rustRoot, process.env.CARGO_TARGET_DIR)
    : join(rustRoot, "target");
  const built = join(targetRoot, "release", "butler-agent");
  if (!existsSync(built)) {
    throw new Error(`Native Butler Agent build did not produce ${built}.`);
  }
  return built;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  if (result.status === 0) return result.stdout.trim();
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
}

function verifyMacDependencyClosure(binary) {
  const result = spawnSync("otool", ["-L", binary], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error("Native Butler Agent dependency inspection failed.");
  }
  const unsupported = result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean)
    .filter((path) => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"));
  if (unsupported.length > 0) {
    throw new Error(`Native Butler Agent has unpackaged runtime dependencies: ${unsupported.join(", ")}`);
  }
}

/**
 * Refuses a Linux agent built for another architecture or needing a shared
 * library outside the glibc runtime, so the payload stays self-contained.
 */
function verifyLinuxDependencyClosure(binary, arch) {
  const header = spawnSync("readelf", ["-h", binary], { encoding: "utf8", stdio: "pipe" });
  const machine = header.stdout?.match(/^\s*Machine:\s*(.+)$/mu)?.[1]?.trim();
  if (header.status !== 0 || machine !== LINUX_ELF_MACHINES[arch]) {
    throw new Error(`Native Butler Agent is not a Linux ${arch} executable (machine: ${machine ?? "unknown"}).`);
  }
  const dynamic = spawnSync("readelf", ["-d", binary], { encoding: "utf8", stdio: "pipe" });
  if (dynamic.status !== 0) {
    throw new Error("Native Butler Agent dependency inspection failed.");
  }
  const unsupported = [...dynamic.stdout.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/gu)]
    .map((match) => match[1])
    .filter((name) => !LINUX_SYSTEM_LIBRARIES.has(name));
  if (unsupported.length > 0) {
    throw new Error(`Native Butler Agent has unpackaged runtime dependencies: ${unsupported.join(", ")}`);
  }
}

function readCargoVersion(path) {
  requireFile(path);
  const body = readFileSync(path, "utf8");
  const value = body.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
  if (!value) throw new Error("Native Butler Agent version is missing.");
  return value;
}

function requireFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Required native packaging file is missing: ${path}`);
  }
}

function setReadOnly(root) {
  const executableDirectory = join(root, "bin");
  for (const path of walk(root).filter((path) => statSync(path).isFile())) {
    chmodSync(path, dirname(path) === executableDirectory ? 0o555 : 0o444);
  }
  for (const path of walk(root).filter((path) => statSync(path).isDirectory()).reverse()) {
    chmodSync(path, 0o555);
  }
  chmodSync(root, 0o555);
}

function makeWritable(root) {
  if (!existsSync(root)) return;
  for (const path of [root, ...walk(root)]) {
    try { chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644); } catch {}
  }
}

function walk(root) {
  if (!existsSync(root)) return [];
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walk(path));
  }
  return paths;
}

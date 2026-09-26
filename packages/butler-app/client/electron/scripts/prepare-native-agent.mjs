#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requestedPlatform = process.argv[2] ?? process.platform;
const requestedArch = process.argv[3] ?? process.arch;
const explicitPayloadRoot = process.argv[4] ? resolve(process.argv[4]) : null;
if (requestedPlatform !== "darwin" || requestedArch !== "arm64") {
  throw new Error(`Native Butler Agent static packaging currently supports only darwin/arm64; requested ${requestedPlatform}/${requestedArch}.`);
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

const prepareScript = join(rustRoot, "scripts", "prepare-static-ort-macos-arm64.py");
const prepared = JSON.parse(run(process.env.PYTHON3 || "python3", [prepareScript], rustRoot));
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
run("cargo", ["build", "--release", "--locked", "-p", "butler-agent"], rustRoot, buildEnv);
const targetRoot = process.env.CARGO_TARGET_DIR
  ? resolve(rustRoot, process.env.CARGO_TARGET_DIR)
  : join(rustRoot, "target");
const sourceBinary = join(targetRoot, "release", "butler-agent");
if (!existsSync(sourceBinary)) {
  throw new Error(`Native Butler Agent build did not produce ${sourceBinary}.`);
}
if (requestedPlatform === "darwin") verifyMacDependencyClosure(sourceBinary);

const payloadRoot = explicitPayloadRoot ??
  join(electronRoot, ".native-agent-payload", "bundled-agent");
makeWritable(payloadRoot);
rmSync(payloadRoot, { recursive: true, force: true });
const binaryRoot = join(payloadRoot, "bin");
mkdirSync(binaryRoot, { recursive: true });
copyFileSync(sourceBinary, join(binaryRoot, "butler-agent"));
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
cpSync(uiDistRoot, join(payloadRoot, "resources", "app-client", "dist"), { recursive: true });
const version = readCargoVersion(join(rustRoot, "agent", "Cargo.toml"));
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
  for (const path of walk(root).filter((path) => statSync(path).isFile())) {
    chmodSync(path, path.endsWith(join("bin", "butler-agent")) ? 0o555 : 0o444);
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

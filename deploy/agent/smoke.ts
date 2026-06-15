#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = resolve(optionValue("--out") ?? "dist/release/agent");
const artifactPath = findOne(/^butler-agent-.*-all\.tar\.gz$/u);
const shaPath = `${artifactPath}.sha256`;
const releaseManifestPath = join(outDir, "agent-release-manifest.json");
const updateManifestPath = join(outDir, "agent-update-manifest.json");

for (const path of [artifactPath, shaPath, releaseManifestPath, updateManifestPath]) {
  if (!existsSync(path)) throw new Error(`missing Butler Agent release file: ${path}`);
}

const expectedSha = readFileSync(shaPath, "utf8").trim().split(/\s+/u)[0] ?? "";
const actualSha = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
if (expectedSha !== actualSha) {
  throw new Error(`Butler Agent artifact checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
}

const listing = spawnSync("tar", ["-tzf", artifactPath], { encoding: "utf8" });
if (listing.status !== 0) {
  throw new Error(`Butler Agent artifact listing failed: ${listing.stderr.trim() || listing.stdout.trim() || "unknown error"}`);
}
for (const requiredEntry of [
  "./install.sh",
  "./package.json",
  "./bin/butler.js",
  "./deploy/agent/package-agent.ts",
  "./deploy/agent/templates/launchd.plist.template",
  "./deploy/agent/templates/systemd.service.template",
  "./packages/butler-agent/resources/app-client/dist/index.html",
]) {
  if (!listing.stdout.includes(requiredEntry)) {
    throw new Error(`Butler Agent artifact is missing ${requiredEntry}`);
  }
}
if (!listing.stdout.includes("./packages/butler-agent/resources/app-client/dist/assets/")) {
  throw new Error("Butler Agent artifact is missing built Butler App web client assets");
}

const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
assertNoServiceAsProductCopy("release manifest", releaseManifest);
assertNoServiceAsProductCopy("update manifest", updateManifest);
if (releaseManifest.product !== "butler-agent") {
  throw new Error(`Agent release manifest product is wrong: ${String(releaseManifest.product)}`);
}
if (!Array.isArray(updateManifest.artifacts) || updateManifest.artifacts[0]?.product !== "butler-agent") {
  throw new Error("Agent update manifest does not expose a Butler Agent artifact");
}
if (releaseManifest.agentArtifactLayout?.executable !== "bin/butler.js") {
  throw new Error("Agent release manifest is missing standalone artifact layout");
}
if (!releaseManifest.agentArtifactLayout?.serviceTemplates?.includes("deploy/agent/templates/systemd.service.template")) {
  throw new Error("Agent release manifest is missing service templates");
}
if (!releaseManifest.operatorCommands?.includes("doctor")) {
  throw new Error("Agent release manifest is missing operator commands");
}
if (releaseManifest.operatorCommandMap?.init?.join(" ") !== "butler install") {
  throw new Error("Agent release manifest init command does not map to butler install");
}
if (updateManifest.agent_artifact_layout?.runtime_resolver !== "packages/butler-agent/scripts/start-butler.sh") {
  throw new Error("Agent update manifest is missing runtime resolver metadata");
}
if (!updateManifest.operator_commands?.includes("start")) {
  throw new Error("Agent update manifest is missing operator command metadata");
}
if (updateManifest.operator_command_map?.doctor?.join(" ") !== "butler doctor") {
  throw new Error("Agent update manifest is missing runnable doctor command metadata");
}

runInstallSmoke({
  artifactPath,
  artifactSha: actualSha,
  releaseManifest,
});

console.log(`Butler Agent release smoke passed: ${basename(artifactPath)}`);

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function findOne(pattern: RegExp): string {
  const matches = readdirSync(outDir).filter((name) => pattern.test(name)).sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${pattern} in ${outDir}, got ${matches.length}`);
  }
  return join(outDir, matches[0]!);
}

function runInstallSmoke(input: {
  artifactPath: string;
  artifactSha: string;
  releaseManifest: any;
}): void {
  const smokeRoot = mkdtempSync(join(tmpdir(), "butler-agent-smoke-"));
  const extractDir = join(smokeRoot, "agent");
  const homeDir = join(smokeRoot, "home");
  const dataDir = join(homeDir, ".butler");
  const blockBin = join(smokeRoot, "blocked-bin");
  try {
    mkdirSync(extractDir, { recursive: true });
    const extract = spawnSync("tar", ["-xzf", input.artifactPath, "-C", extractDir], {
      encoding: "utf8",
    });
    if (extract.status !== 0) {
      throw new Error(`Butler Agent artifact extraction failed: ${commandOutput(extract)}`);
    }

    const launcher = findPackagedLauncher(extractDir, input.releaseManifest);
    const env = smokeEnv({
      extractDir,
      dataDir,
      homeDir,
      blockBin,
    });

    runSmokeCommand("install local artifact", launcher, [
      "install",
      "--profile",
      "agent-standalone",
      "--install-source",
      "local-artifact",
      "--home",
      extractDir,
      "--data",
      dataDir,
      "--language",
      "en",
      "--non-interactive",
      "--no-auto-env",
      "--no-register-service",
    ], env);

    const installedCli = join(dataDir, "bin", "butler");
    if (!existsSync(installedCli)) {
      throw new Error("Agent install smoke did not create BUTLER_DATA/bin/butler");
    }

    const status = runSmokeCommand("status", installedCli, ["status", "--json"], env);
    assertNoServiceAsProductCopy("status output", status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    if (statusPayload.command !== "butler status") {
      throw new Error("Agent status smoke returned an unexpected command envelope");
    }

    const doctor = runSmokeCommand("doctor", installedCli, ["doctor", "--json", "--check", "dependencies"], env);
    const doctorPayload = JSON.parse(doctor.stdout);
    if (!Array.isArray(doctorPayload.checks)) {
      throw new Error("Agent doctor smoke returned an unexpected payload");
    }

    const start = runSmokeCommand("start dry-run", installedCli, ["start", "--dry-run", "--json"], env);
    assertNoServiceAsProductCopy("start dry-run output", start.stdout);
    const startPayload = JSON.parse(start.stdout);
    if (
      startPayload.command !== "start" ||
      startPayload.dryRun !== true ||
      !Array.isArray(startPayload.services) ||
      !Array.isArray(startPayload.preflight) ||
      startPayload.preflight.some((item: { ok?: unknown }) => item.ok !== true)
    ) {
      throw new Error("Agent start dry-run smoke returned an unexpected payload");
    }

    const defaultUpdate = runSmokeCommand("default update dry-run", installedCli, [
      "update",
      "--dry-run",
      "--json",
    ], env);
    assertNoServiceAsProductCopy("default update dry-run output", defaultUpdate.stdout);
    const defaultUpdatePayload = JSON.parse(defaultUpdate.stdout);
    if (defaultUpdatePayload.data?.dryRun !== true || defaultUpdatePayload.data?.product !== "butler-agent") {
      throw new Error("Agent default update dry-run smoke returned an unexpected payload");
    }

    const updateManifest = join(smokeRoot, "agent-update-smoke.json");
    writeFileSync(updateManifest, `${JSON.stringify({
      artifacts: [{
        component: "service",
        version: "99.0.0",
        channel: "stable",
        artifact_url: input.artifactPath,
        sha256: input.artifactSha,
        bundled_components: ["service"],
        product: "butler-agent",
        canonical_component: "agent",
        profile: "agent-standalone",
        protocol_compatibility: {
          protocol: "butler.agent.v1",
          minimumAgentProtocol: "butler.agent.v1",
          maximumAgentProtocol: "butler.agent.v1",
        },
        integrity: {
          digestAlgorithm: "sha256",
          digest: input.artifactSha,
          signature: null,
        },
        update_policy: "explicit",
        restart_policy: "restart-service",
        updater_owner: "butler-agent",
        payload_format: "agent-archive",
        staging_policy: "butler-data-updates",
        activation_policy: "versioned-standalone-runtime",
        rollback_policy: "preserve-previous-standalone-runtime",
      }],
    }, null, 2)}\n`, "utf8");
    const update = runSmokeCommand("update dry-run", installedCli, [
      "update",
      "--dry-run",
      "--manifest",
      updateManifest,
      "--json",
    ], env);
    assertNoServiceAsProductCopy("update dry-run output", update.stdout);
    const updatePayload = JSON.parse(update.stdout);
    if (updatePayload.data?.dryRun !== true || updatePayload.data?.product !== "butler-agent") {
      throw new Error("Agent update dry-run smoke returned an unexpected payload");
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function smokeEnv(input: {
  extractDir: string;
  dataDir: string;
  homeDir: string;
  blockBin: string;
}): Record<string, string> {
  mkdirSync(input.blockBin, { recursive: true });
  for (const blocked of ["git", "curl", "wget", "unzip"]) {
    const path = join(input.blockBin, blocked);
    writeFileSync(path, `#!/usr/bin/env sh\necho "${blocked} must not be used by local Agent artifact smoke" >&2\nexit 127\n`, "utf8");
    chmodSync(path, 0o755);
  }
  return {
    ...process.env,
    HOME: input.homeDir,
    BUTLER_HOME: input.extractDir,
    BUTLER_DATA: input.dataDir,
    BUTLER_BUN: process.execPath,
    BUTLER_ACCEPT_EXPERIMENTAL: "1",
    BUTLER_INSTALL_SOURCE: "local-artifact",
    BUTLER_INSTALL_PROFILE: "agent-standalone",
    BUTLER_SKIP_DEPS: "1",
    BUTLER_SKIP_SERVICES: "1",
    BUTLER_NO_GUM: "1",
    BUTLER_OPENAI_AUTH_METHOD: "codex-subscription",
    PATH: `${input.blockBin}${delimiter}${process.env.PATH ?? ""}`,
  };
}

function findPackagedLauncher(extractDir: string, manifest: any): string {
  const launchers = Array.isArray(manifest.cliLaunchers) ? manifest.cliLaunchers : [];
  const hostPlatform = hostReleasePlatform();
  if (hostPlatform) {
    for (const launcher of launchers) {
      const platform = typeof launcher?.platform === "string" ? launcher.platform : "";
      const relativePath = typeof launcher?.path === "string" ? launcher.path : "";
      if (platform !== hostPlatform || !relativePath) continue;
      const path = join(extractDir, relativePath);
      if (existsSync(path)) return path;
    }
  }
  for (const launcher of launchers) {
    const relativePath = typeof launcher?.path === "string" ? launcher.path : "";
    if (!relativePath) continue;
    const path = join(extractDir, relativePath);
    if (existsSync(path)) return path;
  }
  const fallback = join(extractDir, "bin", "butler.js");
  if (existsSync(fallback)) return fallback;
  throw new Error("Agent release artifact does not contain a runnable launcher");
}

function hostReleasePlatform(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-arm64";
  }
  return null;
}

function runSmokeCommand(
  label: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, {
    cwd: env.BUTLER_HOME,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`Agent ${label} smoke failed: ${commandOutput(result)}`);
  }
  return result;
}

function commandOutput(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || `exit ${result.status ?? "unknown"}`;
}

function assertNoServiceAsProductCopy(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (/"product"\s*:\s*"service"/u.test(text)) {
    throw new Error(`Agent ${label} still exposes service-as-product copy`);
  }
}

#!/usr/bin/env bun
// Developer ID signing, verification and notarization helpers for the native
// macOS Butler App release. Apple recommends signing nested code inside-out
// instead of `codesign --deep`: every nested Mach-O and bundle is signed with
// its own options before the bundle that contains it is sealed.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const MAC_ELECTRON_ENTITLEMENTS = resolve(import.meta.dir, "macos", "electron.entitlements.plist");
export const MAC_AGENT_IDENTIFIER = "com.hexpy.butler.agent";
const NATIVE_AGENT_BINARY = join("Contents", "Resources", "bundled-agent", "bin", "butler-agent");
const BUNDLE_EXTENSIONS = [".app", ".framework", ".xpc", ".appex"];

export type MacSigningConfig =
  | { mode: "production"; identity: string; keychain: string | null }
  | { mode: "ad-hoc" };

export interface MacNotaryConfig {
  profile: string;
  keychain: string | null;
}

export interface MacCodeSigningTarget {
  path: string;
  kind: "file" | "bundle";
  // Entitlements are granted per process. Only the Electron main app and the
  // Electron helper apps run V8, so only they receive the Electron entitlements
  // (see macos/electron.entitlements.plist and packages/butler-app/scripts/README.md).
  // The native Agent, the menu bar helper, crashpad, ShipIt, frameworks and
  // dylibs run under the hardened runtime with no exceptions.
  entitlements: "electron" | null;
  identifier: string | null;
}

type Env = Record<string, string | undefined>;

export function macSigningConfigFromEnv(env: Env): MacSigningConfig {
  const identity = env.BUTLER_APP_SIGN_IDENTITY?.trim();
  if (identity) {
    return { mode: "production", identity, keychain: env.BUTLER_APP_SIGN_KEYCHAIN?.trim() || null };
  }
  if (env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1") {
    throw new Error("BUTLER_APP_SIGN_IDENTITY is required for production macOS releases");
  }
  return { mode: "ad-hoc" };
}

export function macNotaryConfigFromEnv(env: Env): MacNotaryConfig | null {
  const profile = env.BUTLER_APP_NOTARY_KEYCHAIN_PROFILE?.trim();
  if (profile) return { profile, keychain: env.BUTLER_APP_NOTARY_KEYCHAIN?.trim() || null };
  if (env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1") {
    throw new Error("BUTLER_APP_NOTARY_KEYCHAIN_PROFILE is required for production macOS releases");
  }
  return null;
}

// Returns every piece of code in the App, deepest first, ending with the App
// itself. A nested item is always deeper than its container, so this order
// signs contents before the bundle that seals them.
export function planMacCodeSigning(appBundle: string): MacCodeSigningTarget[] {
  const root = resolve(appBundle);
  const bundles: string[] = [];
  const files: string[] = [];
  walk(root, bundles, files);
  const mainExecutables = new Set([root, ...bundles].map(bundleMainExecutable).filter(Boolean));
  const helperParent = join(root, "Contents", "Frameworks");
  const targets: MacCodeSigningTarget[] = [
    ...files
      .filter((path) => !mainExecutables.has(path) && isMachO(path))
      .map((path): MacCodeSigningTarget => ({
        path,
        kind: "file",
        entitlements: null,
        identifier: relative(root, path) === NATIVE_AGENT_BINARY ? MAC_AGENT_IDENTIFIER : null,
      })),
    ...bundles.map((path): MacCodeSigningTarget => ({
      path,
      kind: "bundle",
      entitlements: path.endsWith(".app") && dirname(path) === helperParent ? "electron" : null,
      identifier: null,
    })),
  ];
  targets.sort((left, right) => depth(right.path) - depth(left.path) || left.path.localeCompare(right.path));
  targets.push({ path: root, kind: "bundle", entitlements: "electron", identifier: null });
  return targets;
}

export function codesignArguments(
  target: MacCodeSigningTarget,
  config: MacSigningConfig,
  electronEntitlements: string,
): string[] {
  const args = ["--force", "--sign", config.mode === "production" ? config.identity : "-"];
  if (config.mode === "production") {
    if (config.keychain) args.push("--keychain", config.keychain);
    args.push("--timestamp", "--options", "runtime");
  }
  if (target.entitlements === "electron") args.push("--entitlements", electronEntitlements);
  if (target.identifier) args.push("--identifier", target.identifier);
  args.push(target.path);
  return args;
}

export type CodesignRunner = (args: string[]) => void;

export function signMacCodeInsideOut(
  appBundle: string,
  config: MacSigningConfig,
  electronEntitlements: string = MAC_ELECTRON_ENTITLEMENTS,
  runCodesign: CodesignRunner = runCodesignCommand,
): MacCodeSigningTarget[] {
  const plan = planMacCodeSigning(appBundle);
  for (const target of plan) {
    const args = codesignArguments(target, config, electronEntitlements);
    if (target.kind === "file") withOwnerWritable(target.path, () => runCodesign(args));
    else runCodesign(args);
  }
  return plan;
}

function runCodesignCommand(args: string[]): void {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`codesign failed for ${args.at(-1)}: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error"}`);
  }
}

// The bundled Agent payload is deliberately read-only. codesign rewrites a file
// through a sibling temp file, so the file and its directory are made writable
// for the signing call only and their original modes are restored afterwards.
function withOwnerWritable(path: string, action: () => void): void {
  const directory = dirname(path);
  const directoryMode = statSync(directory).mode & 0o7777;
  const fileMode = statSync(path).mode & 0o7777;
  chmodSync(directory, directoryMode | 0o200);
  chmodSync(path, fileMode | 0o200);
  try {
    action();
  } finally {
    if (existsSync(path)) chmodSync(path, fileMode);
    chmodSync(directory, directoryMode);
  }
}

function walk(directory: string, bundles: string[], files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (BUNDLE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) bundles.push(path);
      walk(path, bundles, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

function bundleMainExecutable(bundle: string): string | null {
  if (bundle.endsWith(".framework")) {
    const name = basename(bundle, ".framework");
    const versions = join(bundle, "Versions");
    if (!existsSync(versions)) return join(bundle, name);
    for (const version of readdirSync(versions)) {
      const candidate = join(versions, version, name);
      if (version !== "Current" && existsSync(candidate)) return candidate;
    }
    return null;
  }
  const contents = join(bundle, "Contents");
  const executable = readPlistString(join(contents, "Info.plist"), "CFBundleExecutable") ??
    basename(bundle).replace(/\.[^.]+$/u, "");
  return join(contents, "MacOS", executable);
}

function readPlistString(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const body = readFileSync(path);
  if (body.subarray(0, 6).toString("latin1") === "bplist") {
    const converted = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", path], { encoding: "utf8" });
    return converted.status === 0 ? converted.stdout.trim() || null : null;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return body.toString("utf8").match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`, "u"))?.[1] ?? null;
}

function isMachO(path: string): boolean {
  const header = Buffer.alloc(8);
  const fd = openSync(path, "r");
  const length = (() => {
    try {
      return readSync(fd, header, 0, 8, 0);
    } finally {
      closeSync(fd);
    }
  })();
  if (length < 4) return false;
  const magic = header.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  // Universal binaries share 0xcafebabe with Java class files; a fat header
  // counts architectures where a class file stores its (>= 45) major version.
  if (magic === 0xcafebabe || magic === 0xcafebabf) return length >= 8 && header.readUInt32BE(4) < 45;
  return false;
}

function depth(path: string): number {
  return path.split(sep).length;
}

export interface CodesigningIdentity {
  hash: string;
  name: string;
}

export function parseCodesigningIdentities(output: string): CodesigningIdentity[] {
  return [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gmu)].map((match) => ({
    hash: match[1]!,
    name: match[2]!,
  }));
}

export function selectDeveloperIdIdentity(
  identities: CodesigningIdentity[],
  teamId: string | null,
): CodesigningIdentity {
  const developerIds = identities.filter((identity) => identity.name.startsWith("Developer ID Application: "));
  const matches = teamId
    ? developerIds.filter((identity) => identity.name.endsWith(`(${teamId})`))
    : developerIds;
  if (matches.length === 0) {
    throw new Error(teamId
      ? `no Developer ID Application identity for team ${teamId}`
      : "no Developer ID Application identity");
  }
  const unique = [...new Map(matches.map((identity) => [identity.hash, identity])).values()];
  if (unique.length > 1) {
    throw new Error(`multiple Developer ID Application identities match; set the team ID: ${unique.map((identity) => identity.name).join(", ")}`);
  }
  return unique[0]!;
}

export interface CodesignDisplay {
  identifier: string | null;
  authorities: string[];
  teamIdentifier: string | null;
  flags: string[];
  timestamped: boolean;
  adHoc: boolean;
}

export function parseCodesignDisplay(output: string): CodesignDisplay {
  const lines = output.split(/\r?\n/u);
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? null;
  const flagText = output.match(/\bflags=0x[0-9a-f]+\(([^)]*)\)/iu)?.[1] ?? "";
  const flags = flagText.split(",").map((flag) => flag.trim()).filter((flag) => flag && flag !== "none");
  const team = value("TeamIdentifier");
  return {
    identifier: value("Identifier"),
    authorities: lines.filter((line) => line.startsWith("Authority=")).map((line) => line.slice("Authority=".length).trim()),
    teamIdentifier: team && team !== "not set" ? team : null,
    flags,
    timestamped: value("Timestamp") !== null,
    adHoc: value("Signature") === "adhoc" || flags.includes("adhoc"),
  };
}

export function productionSignatureIssues(
  display: CodesignDisplay,
  options: { teamId: string | null; requireRuntime?: boolean },
): string[] {
  const issues: string[] = [];
  if (display.adHoc) issues.push("ad-hoc signature");
  if (!display.authorities[0]?.startsWith("Developer ID Application: ")) {
    issues.push("not signed with a Developer ID Application certificate");
  } else if (options.teamId && display.teamIdentifier !== options.teamId) {
    issues.push(`team identifier ${display.teamIdentifier ?? "missing"} does not match ${options.teamId}`);
  }
  if (options.requireRuntime !== false && !display.flags.includes("runtime")) issues.push("hardened runtime is not enabled");
  if (!display.timestamped) issues.push("secure timestamp is missing");
  return issues;
}

// Production gate for the release package and the release smoke: every nested
// piece of code must carry a timestamped, hardened Developer ID signature from
// the release team, and the Electron processes must keep their JIT entitlement.
export function verifyMacProductionCodeSignatures(appBundle: string, teamId: string | null): void {
  const failures: string[] = [];
  for (const target of planMacCodeSigning(appBundle)) {
    const label = relative(resolve(appBundle, ".."), target.path);
    const display = spawnSync("codesign", ["--display", "--verbose=4", target.path], { encoding: "utf8" });
    if (display.status !== 0) {
      failures.push(`${label}: ${display.stderr.trim() || "unsigned"}`);
      continue;
    }
    const issues = productionSignatureIssues(parseCodesignDisplay(`${display.stdout}\n${display.stderr}`), { teamId });
    if (target.entitlements === "electron") {
      const entitlements = spawnSync("codesign", ["--display", "--entitlements", "-", "--xml", target.path], { encoding: "utf8" });
      if (!entitlements.stdout.includes("com.apple.security.cs.allow-jit")) issues.push("Electron JIT entitlement is missing");
    }
    for (const issue of issues) failures.push(`${label}: ${issue}`);
  }
  if (failures.length) throw new Error(`production macOS signature check failed:\n${failures.join("\n")}`);
}

export function verifyMacProductionContainerSignature(path: string, teamId: string | null): void {
  const display = spawnSync("codesign", ["--display", "--verbose=4", path], { encoding: "utf8" });
  const issues = display.status === 0
    ? productionSignatureIssues(parseCodesignDisplay(`${display.stdout}\n${display.stderr}`), { teamId, requireRuntime: false })
    : [display.stderr.trim() || "unsigned"];
  if (issues.length) throw new Error(`production macOS signature check failed for ${basename(path)}: ${issues.join("; ")}`);
}

export function notarytoolSubmitArguments(artifactPath: string, config: MacNotaryConfig): string[] {
  return [
    "notarytool", "submit", artifactPath,
    "--keychain-profile", config.profile,
    ...(config.keychain ? ["--keychain", config.keychain] : []),
    "--wait",
    "--output-format", "json",
  ];
}

export function notarytoolLogArguments(submissionId: string, config: MacNotaryConfig): string[] {
  return [
    "notarytool", "log", submissionId,
    "--keychain-profile", config.profile,
    ...(config.keychain ? ["--keychain", config.keychain] : []),
  ];
}

export interface NotarySubmission {
  id: string;
  status: string;
  message: string | null;
}

export function parseNotarySubmission(output: string): NotarySubmission | null {
  for (const line of output.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.id === "string" && typeof parsed.status === "string") {
        return { id: parsed.id, status: parsed.status, message: typeof parsed.message === "string" ? parsed.message : null };
      }
    } catch {}
  }
  return null;
}

export function submitMacNotarization(artifactPath: string, config: MacNotaryConfig): NotarySubmission {
  const submit = spawnSync("xcrun", notarytoolSubmitArguments(artifactPath, config), { encoding: "utf8" });
  const submission = parseNotarySubmission(submit.stdout);
  if (submission?.status === "Accepted") return submission;
  let log = "";
  if (submission) {
    const fetched = spawnSync("xcrun", notarytoolLogArguments(submission.id, config), { encoding: "utf8" });
    log = (fetched.stdout.trim() || fetched.stderr.trim()).slice(0, 8000);
  }
  const summary = submission
    ? `submission ${submission.id} is ${submission.status}${submission.message ? ` (${submission.message})` : ""}`
    : submit.stderr.trim() || submit.stdout.trim() || submit.error?.message || "unknown error";
  throw new Error(`mac notarization failed for ${basename(artifactPath)}: ${summary}${log ? `\n${log}` : ""}`);
}

export function evaluateGatekeeperAssessment(status: number | null, output: string): { ok: boolean; warning: string | null } {
  if (status !== 0) return { ok: false, warning: null };
  if (/^source=Notarized Developer ID$/mu.test(output)) return { ok: true, warning: null };
  if (/^override=security disabled$/mu.test(output)) {
    return {
      ok: true,
      warning: "Gatekeeper assessments are disabled on this host; notarization is proven by the stapled ticket",
    };
  }
  return { ok: false, warning: null };
}

export function assessMacGatekeeper(path: string, type: "execute" | "open"): void {
  const args = type === "execute"
    ? ["--assess", "--type", "execute", "--verbose=4", path]
    : ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", path];
  const result = spawnSync("spctl", args, { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  const assessment = evaluateGatekeeperAssessment(result.status, output);
  if (!assessment.ok) {
    throw new Error(`Gatekeeper rejected ${basename(path)}: ${output.trim() || result.error?.message || "unknown error"}`);
  }
  if (assessment.warning) process.stderr.write(`warning: ${basename(path)}: ${assessment.warning}\n`);
}

function selectIdentityCli(args: string[]): void {
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1]?.trim() || null;
  };
  const keychain = option("--keychain");
  const teamId = option("--team-id");
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning", ...(keychain ? [keychain] : [])], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`security find-identity failed: ${result.stderr.trim()}`);
  process.stdout.write(`${selectDeveloperIdIdentity(parseCodesigningIdentities(result.stdout), teamId).hash}\n`);
}

if (import.meta.main) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command !== "select-identity") {
      throw new Error("usage: mac-signing.ts select-identity [--keychain PATH] [--team-id TEAMID]");
    }
    selectIdentityCli(rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

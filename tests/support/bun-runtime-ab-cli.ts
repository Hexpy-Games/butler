import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUN_RUNTIME_AB_SCHEMA,
  CANDIDATE_BUN_VERSION,
  createBunRuntimeAbManifest,
  compareBunRuntimeAb,
  PINNED_BUN_VERSION,
  type BunRuntimeAbManifest,
} from "./bun-runtime-ab.ts";
import {
  runElectronParentArchiveGuard,
} from "./bun-runtime-ab-archive-guard.ts";
import { ARCHIVE_STREAM_GUARD_ATTEMPTS } from "./bun-runtime-ab.ts";
import {
  runPackagedMemoryCampaign,
} from "../e2e/btcc-r3-electron/packaged-memory-campaign.ts";
import { campaignAsBunRuntimeEvidence } from "../e2e/btcc-r3-electron/packaged-memory-campaign-contracts.ts";
import {
  portableCommandLabel,
  portableExecutableLabel,
  portableGuardIdentity,
  type PackagedMemoryGuardEvidence,
} from "../e2e/btcc-r3-electron/packaged-memory-campaign-evidence.ts";

export function runBunRuntimeAbCli(argv: string[]): string {
  const command = argv[0];
  if (command === "compare") {
    const inputPath = requiredOption(argv, "--input");
    const manifest = JSON.parse(readFileSync(inputPath, "utf8")) as BunRuntimeAbManifest;
    const report = compareBunRuntimeAb(manifest);
    return emit(JSON.stringify(report, null, 2), option(argv, "--output"));
  }
  if (command === "versions") {
    const pinned = bunVersion(requiredOption(argv, "--pinned-bun"));
    const candidate = bunVersion(requiredOption(argv, "--candidate-bun"));
    return JSON.stringify({
      schema: BUN_RUNTIME_AB_SCHEMA,
      pinned,
      candidate,
      expected: { pinned: PINNED_BUN_VERSION, candidate: CANDIDATE_BUN_VERSION },
    }, null, 2);
  }
  if (command === "archive-guard") {
    const result = runElectronParentArchiveGuard({
      parentExecutable: requiredOption(argv, "--parent"),
      parentArgs: repeatedOption(argv, "--arg"),
      bunExecutable: requiredOption(argv, "--bun"),
      attempts: parsePositiveInt(option(argv, "--attempts"), ARCHIVE_STREAM_GUARD_ATTEMPTS),
      timeoutMs: parsePositiveInt(option(argv, "--timeout-ms"), 60_000),
      cwd: option(argv, "--cwd"),
    });
    return emit(JSON.stringify(portableGuardResult(result), null, 2), option(argv, "--output"));
  }
  if (command === "packaging-guard") {
    const result = runPackagingGuard({
      bunExecutable: requiredOption(argv, "--bun"),
      repoRoot: requiredOption(argv, "--repo-root"),
    });
    return emit(JSON.stringify(portableGuardResult(result), null, 2), option(argv, "--output"));
  }
  if (command === "manifest") {
    const pinned = readBunEvidence(requiredOption(argv, "--pinned-evidence"), "pinned");
    const candidate = readBunEvidence(requiredOption(argv, "--candidate-evidence"), "candidate");
    return emit(JSON.stringify(createBunRuntimeAbManifest(pinned, candidate), null, 2), option(argv, "--output"));
  }
  if (command === "campaign") {
    throw new Error("campaign is asynchronous; invoke runBunRuntimeAbCampaignCli");
  }
  return [
    "Usage:",
    "  bun-runtime-ab compare --input MANIFEST [--output REPORT]",
    "  bun-runtime-ab versions --pinned-bun PATH --candidate-bun PATH",
    "  bun-runtime-ab archive-guard --parent PATH --arg ARG --bun PATH [--attempts N]",
    "  bun-runtime-ab packaging-guard --bun PATH --repo-root PATH --output FILE",
    "  bun-runtime-ab manifest --pinned-evidence FILE --candidate-evidence FILE [--output FILE]",
    "  bun-runtime-ab campaign --variant pinned|candidate --repo-root PATH --source-data PATH",
  ].join("\n");
}

export async function runBunRuntimeAbCampaignCli(argv: string[]): Promise<string> {
  const runtimeVariant = (option(argv, "--variant") ?? "pinned") as "pinned" | "candidate";
  const expectedVersion = runtimeVariant === "candidate" ? CANDIDATE_BUN_VERSION : PINNED_BUN_VERSION;
  const archiveEvidence = evidenceFile(argv, "--archive-evidence", "archive-stream guard", 10, "butler.archive-stream-guard.v1", expectedVersion);
  const packagingEvidence = evidenceFile(argv, "--packaging-evidence", "release packaging", 23, "butler.bun-packaging-guard.v1", expectedVersion);
  const result = await runPackagedMemoryCampaign({
      repoRoot: option(argv, "--repo-root"),
      sourceData: option(argv, "--source-data"),
      runRoot: option(argv, "--run-root"),
      runtimeVariant,
      warmupCycles: parsePositiveInt(option(argv, "--warmup-cycles"), 3),
      steadyCycles: parsePositiveInt(option(argv, "--steady-cycles"), 6),
      historyMessages: parsePositiveInt(option(argv, "--history-messages"), 1_200),
      idleWaitMs: parsePositiveInt(option(argv, "--idle-wait-ms"), 47_000),
      archiveStreamEvidence: archiveEvidence,
      packagingEvidence,
      keepLogs: true,
    });
  return emit(JSON.stringify(campaignAsBunRuntimeEvidence(result), null, 2), option(argv, "--output"));
}

export function bunVersion(executable: string): string {
  return execFileSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requiredOption(argv: string[], name: string): string {
  const value = option(argv, name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function repeatedOption(argv: string[], name: string): string[] {
  return argv.flatMap((value, index) =>
    value === name && argv[index + 1] ? [argv[index + 1]!] : [],
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function evidenceFile(
  argv: string[],
  optionName: string,
  label: string,
  expectedAttempts: number,
  expectedSchema: string,
  expectedVersion: string,
): PackagedMemoryGuardEvidence {
  const path = option(argv, optionName);
  if (!path) {
    return { ok: false, reason: `${label} evidence file was not supplied`, attempts: 0, successes: 0 };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const validated = validateCampaignEvidence(value, expectedAttempts, expectedSchema, expectedVersion);
    return {
      ...validated,
      schema: typeof value.schema === "string" ? value.schema : undefined,
      executableLabel: typeof value.executableLabel === "string"
        ? portableExecutableLabel(value.executableLabel)
        : undefined,
      executableFingerprint: typeof value.executableFingerprint === "string"
        ? value.executableFingerprint
        : undefined,
      bunVersion: typeof value.bunVersion === "string" ? value.bunVersion : undefined,
      commandLabel: typeof value.commandLabel === "string"
        ? portableCommandLabel(value.commandLabel)
        : undefined,
      commandFingerprint: typeof value.commandFingerprint === "string"
        ? value.commandFingerprint
        : undefined,
      reason: validated.ok
        ? `${label} evidence verified from a structured ${expectedAttempts}/${expectedAttempts} artifact`
        : `${label} evidence failed structured ${expectedAttempts}/${expectedAttempts} validation`,
    };
  } catch {
    return { ok: false, reason: `${label} evidence file could not be parsed`, attempts: 0, successes: 0 };
  }
}

export function validateCampaignEvidence(
  value: {
    ok?: unknown;
    attempts?: unknown;
    successes?: unknown;
    schema?: unknown;
    commandLabel?: unknown;
    commandFingerprint?: unknown;
    bunVersion?: unknown;
    executableLabel?: unknown;
    executableFingerprint?: unknown;
  },
  expectedAttempts: number,
  expectedSchema?: string,
  expectedVersion?: string,
): { ok: boolean; attempts: number; successes: number; reason?: string } {
  const attempts = Number(value.attempts);
  const successes = Number(value.successes);
  return {
    ok: value.ok === true && attempts === expectedAttempts && successes === expectedAttempts &&
      (!expectedSchema || value.schema === expectedSchema) &&
      typeof value.commandLabel === "string" && value.commandLabel.length > 0 &&
      typeof value.commandFingerprint === "string" && value.commandFingerprint.length > 0 &&
      typeof value.executableLabel === "string" && value.executableLabel.length > 0 &&
      typeof value.executableFingerprint === "string" && value.executableFingerprint.length > 0 &&
      (!expectedVersion || value.bunVersion === expectedVersion),
    attempts: Number.isSafeInteger(attempts) ? attempts : 0,
    successes: Number.isSafeInteger(successes) ? successes : 0,
  };
}

function readBunEvidence(path: string, expectedVariant: "pinned" | "candidate") {
  const value = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof campaignAsBunRuntimeEvidence>;
  if (value.variant !== expectedVariant) throw new Error(`${path} is not ${expectedVariant} campaign evidence`);
  const expectedVersion = expectedVariant === "candidate" ? CANDIDATE_BUN_VERSION : PINNED_BUN_VERSION;
  if (value.version !== expectedVersion) throw new Error(`${path} has an unexpected outer Bun version`);
  return value;
}

function runPackagingGuard(input: { bunExecutable: string; repoRoot: string }): {
  schema: "butler.bun-packaging-guard.v1";
  ok: boolean;
  attempts: number;
  successes: number;
  command: string[];
  bunVersion: string;
  bunExecutable: string;
  failure?: string;
} {
  const reportRoot = mkdtempSync(join(tmpdir(), "butler-packaging-guard-"));
  const reportPath = join(reportRoot, "release-packaging.junit.xml");
  const command = ["test", "--reporter=junit", "--reporter-outfile", reportPath, "tests/unit/release-packaging.test.ts"];
  const bunVersionText = bunVersion(input.bunExecutable);
  try {
    execFileSync(input.bunExecutable, command, {
      cwd: input.repoRoot,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    const report = readFileSync(reportPath, "utf8");
    const tests = Number(/tests="(\d+)"/u.exec(report)?.[1] ?? 0);
    const failures = Number(/failures="(\d+)"/u.exec(report)?.[1] ?? 0);
    const result: {
      schema: "butler.bun-packaging-guard.v1";
      ok: boolean;
      attempts: number;
      successes: number;
      command: string[];
      bunVersion: string;
      bunExecutable: string;
      failure?: string;
    } = {
      schema: "butler.bun-packaging-guard.v1",
      ok: tests === 23 && failures === 0,
      attempts: tests,
      successes: Math.max(0, tests - failures),
      command,
      bunVersion: bunVersionText,
      bunExecutable: input.bunExecutable,
      ...(tests === 23 && failures === 0 ? {} : { failure: `release packaging reporter returned tests=${tests}, failures=${failures}` }),
    };
    rmSync(reportRoot, { recursive: true, force: true });
    return result;
  } catch (error) {
    const result: {
      schema: "butler.bun-packaging-guard.v1";
      ok: boolean;
      attempts: number;
      successes: number;
      command: string[];
      bunVersion: string;
      bunExecutable: string;
      failure?: string;
    } = {
      schema: "butler.bun-packaging-guard.v1",
      ok: false,
      attempts: 0,
      successes: 0,
      command,
      bunVersion: bunVersionText,
      bunExecutable: input.bunExecutable,
      failure: error instanceof Error ? error.message : String(error),
    };
    rmSync(reportRoot, { recursive: true, force: true });
    return result;
  }
}

function portableGuardResult(result: {
  schema: string;
  ok: boolean;
  attempts: number;
  successes: number;
  failures?: string[];
  command?: readonly string[];
  bunExecutable?: string;
  bunVersion?: string;
  failure?: string;
}): PackagedMemoryGuardEvidence {
  const identity = portableGuardIdentity({
    bunExecutable: result.bunExecutable,
    command: result.command,
  });
  return {
    schema: result.schema,
    ok: result.ok,
    attempts: result.attempts,
    successes: result.successes,
    reason: result.ok ? "guard completed" : "guard failed",
    bunVersion: result.bunVersion,
    ...identity,
  };
}

function emit(output: string, path?: string): string {
  if (path && path !== "-") writeFileSync(path, `${output}\n`, "utf8");
  return output;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const requestedRuntime = option(argv, "--bun");
  const output = argv[0] === "campaign" && requestedRuntime && !argv.includes("--runtime-child")
    ? execFileSync(requestedRuntime, ["run", import.meta.filename, ...argv.filter((value) => value !== "--bun" && value !== requestedRuntime), "--runtime-child"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: process.env,
    })
    : argv[0] === "campaign"
      ? await runBunRuntimeAbCampaignCli(argv)
    : runBunRuntimeAbCli(argv);
  const outputPath = option(argv, "--output");
  if (!outputPath || outputPath === "-") console.log(output);
}

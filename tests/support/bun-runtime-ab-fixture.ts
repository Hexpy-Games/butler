import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capturePackagedPerformanceSnapshot,
  type PackagedPerformanceSnapshot,
  type PackagedProcessTarget,
} from "./packaged-performance-snapshot.ts";
import {
  evaluatePhysicalMemoryGate,
  type PhysicalMemoryGateResult,
} from "./physical-memory-gate.ts";
import type { BunRuntimeCheck, BunRuntimeEvidence } from "./bun-runtime-ab.ts";
import {
  portableExecutableLabel,
  portableValueFingerprint,
} from "../e2e/btcc-r3-electron/packaged-memory-campaign-evidence.ts";

/**
 * A deterministic process-level fallback for RMF-SC10 when the full Electron
 * campaign is not available. It intentionally leaves the embed idle gate
 * unsupported, so its report cannot authorize a runtime pin change.
 */
export async function runBunRuntimeAbFixture(argv: string[]): Promise<BunRuntimeEvidence & {
  schema: "butler.bun-runtime-ab-fixture.v1";
  snapshots: PackagedPerformanceSnapshot[];
  physicalGate: PhysicalMemoryGateResult;
}> {
  const butlerData = requiredOption(argv, "--butler-data");
  const warmupCycles = positiveInt(option(argv, "--warmup"), 2);
  const steadyCycles = positiveInt(option(argv, "--cycles"), 6);
  const sourceFingerprint = option(argv, "--source-fingerprint") ?? "fixture-source-v1";
  const archiveReportPath = option(argv, "--archive-report");
  mkdirSync(butlerData, { recursive: true });
  writeFileSync(join(butlerData, "fixture.sqlite"), "bun-runtime-ab-fixture-v1\n", "utf8");
  const dataFingerprint = hashDataFixture(butlerData);
  const processTargets: PackagedProcessTarget[] = [
    { role: "agent_runtime", pid: process.pid, label: "bun-ab-fixture" },
  ];
  const snapshots: PackagedPerformanceSnapshot[] = [];
  const correctnessDigest = createHash("sha256");
  for (let index = 0; index < warmupCycles + steadyCycles; index += 1) {
    const allocation = Buffer.alloc(2 * 1024 * 1024, index & 0xff);
    correctnessDigest.update(allocation.subarray(0, 1024));
    snapshots.push(capturePackagedPerformanceSnapshot({
      butlerData,
      processTargets,
      cycle: {
        index,
        phase: index < warmupCycles ? "warmup" : "steady",
      },
    }));
    await Bun.sleep(30);
  }
  const physicalGate = evaluatePhysicalMemoryGate({
    cycles: snapshots,
    warmupCycles,
    idleReclamation: {
      baselineBytes: null,
      loadedBytes: null,
      afterIdleBytes: null,
    },
  });
  const expectedDigest = createHash("sha256");
  for (let index = 0; index < warmupCycles + steadyCycles; index += 1) {
    expectedDigest.update(Buffer.alloc(1024, index & 0xff));
  }
  const correctness: BunRuntimeCheck = {
    ok: correctnessDigest.digest("hex") === expectedDigest.digest("hex"),
  };
  const archiveStream = archiveReportPath
    ? archiveCheck(JSON.parse(readFileSync(archiveReportPath, "utf8")) as Record<string, unknown>)
    : { ok: false, detail: "Electron-parent archive guard report was not supplied" };
  const packaging: BunRuntimeCheck = {
    ok: false,
    detail: "isolated fixture does not exercise packaged Electron artifacts",
  };
  const evidence: BunRuntimeEvidence = {
    variant: option(argv, "--variant") === "candidate" ? "candidate" : "pinned",
    executable: portableExecutableLabel(process.execPath),
    executableFingerprint: portableValueFingerprint(process.execPath),
    version: process.versions.bun,
    sourceFingerprint,
    dataFingerprint,
    warmupCycles,
    steadyCycles,
    processTargets,
    cacheFingerprint: "bun-runtime-ab-fixture-cache-v1",
    physicalGate,
    correctness,
    archiveStream,
    packaging,
  };
  const output = {
    schema: "butler.bun-runtime-ab-fixture.v1" as const,
    ...evidence,
    snapshots,
    physicalGate,
  };
  const outputPath = option(argv, "--output");
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

function archiveCheck(value: Record<string, unknown>): BunRuntimeCheck {
  return {
    ok: value.ok === true,
    ...(value.ok === true ? {} : { detail: "Electron-parent archive guard failed" }),
    ...(typeof value.commandLabel === "string" ? { commandLabel: value.commandLabel } : {}),
    ...(typeof value.commandFingerprint === "string" ? { commandFingerprint: value.commandFingerprint } : {}),
    ...(typeof value.attempts === "number" ? { attempts: value.attempts } : {}),
    ...(typeof value.successes === "number" ? { successes: value.successes } : {}),
    ...(typeof value.executableLabel === "string" ? { executable: value.executableLabel } : {}),
    ...(typeof value.executableFingerprint === "string"
      ? { executableFingerprint: value.executableFingerprint }
      : {}),
  };
}

function hashDataFixture(root: string): string {
  return createHash("sha256").update(readFileSync(join(root, "fixture.sqlite"))).digest("hex");
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

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

if (import.meta.main) {
  const result = await runBunRuntimeAbFixture(process.argv.slice(2));
  if (!option(process.argv.slice(2), "--output")) console.log(JSON.stringify(result, null, 2));
}

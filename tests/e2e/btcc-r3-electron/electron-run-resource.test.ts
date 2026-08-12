import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledAgentPreparationError,
  bundledAgentFilesystemRequirements,
  evaluateBundledAgentDiskCapacity,
  preflightBundledAgentDiskCapacity,
  safeAvailableBytes,
} from "./electron-run-resource.ts";

test("bundled Agent preparation fails closed before packaging when disk is exhausted", () => {
  const decision = evaluateBundledAgentDiskCapacity(0);
  expect(decision).toMatchObject({
    ok: false,
    failure: {
      stage: "bundled_agent_preparation",
      cause: "disk_space_exhausted",
      owner: "electron_harness",
      exitCode: null,
      signal: null,
      availableBytes: 0,
    },
  });
  if (!decision.ok) expect(decision.failure.requiredBytes).toBeGreaterThan(0);
  if (!decision.ok) {
    expect(decision.failure.requiredBytes).toBe(
      4 * 2 * 1024 * 1024 * 1024 + 512 * 1024 * 1024,
    );
  }
});

test("same-volume reserve is the lifecycle peak rather than a sequential sum", () => {
  const runPeak = 4 * 2 * 1024 * 1024 * 1024 + 512 * 1024 * 1024;
  const packagePeak = 2 * 1024 * 1024 * 1024;
  expect(bundledAgentFilesystemRequirements(true)).toEqual({
    runBytes: runPeak,
    packageStageBytes: null,
  });
  expect(bundledAgentFilesystemRequirements(false)).toEqual({
    runBytes: runPeak,
    packageStageBytes: packagePeak,
  });
  expect(evaluateBundledAgentDiskCapacity(runPeak)).toEqual({ ok: true });
});

test("resource inspection failure and byte overflow do not claim disk exhaustion", () => {
  expect(safeAvailableBytes(BigInt(Number.MAX_SAFE_INTEGER), 2n)).toBeNull();
  expect(safeAvailableBytes(-1n, 4096n)).toBeNull();
  expect(safeAvailableBytes(1n, 0n)).toBeNull();
  expect(evaluateBundledAgentDiskCapacity(null)).toEqual({
    ok: false,
    failure: {
      stage: "bundled_agent_preparation",
      cause: "resource_inspection_failed",
      owner: "electron_harness",
      exitCode: null,
      signal: null,
      availableBytes: null,
      requiredBytes: 4 * 2 * 1024 * 1024 * 1024 + 512 * 1024 * 1024,
    },
  });
  expect(() => preflightBundledAgentDiskCapacity(
    "/path-that-does-not-exist/butler-resource-preflight",
  )).toThrow("could not verify disk capacity");
});

test("packaging subprocess ENOSPC is normalized after output sanitization", () => {
  expect(bundledAgentPreparationError(
    new Error("bundled Agent package failed: ENOSPC: no space left on device, write"),
  )?.failure).toMatchObject({
    stage: "bundled_agent_preparation",
    cause: "disk_space_exhausted",
    owner: "electron_harness",
    exitCode: null,
    signal: null,
  });
  expect(bundledAgentPreparationError(new Error("build failed"))).toBeNull();
});

test("bundled Agent preparation accepts capacity above its deterministic reserve", () => {
  expect(evaluateBundledAgentDiskCapacity(Number.MAX_SAFE_INTEGER)).toEqual({
    ok: true,
  });
});

test("bundled Agent disk adapter checks the real run-root filesystem", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "butler-electron-resource-"));
  try {
    expect(() => preflightBundledAgentDiskCapacity(runRoot)).not.toThrow();
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

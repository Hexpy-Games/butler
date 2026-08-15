import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PACKAGED_MEMORY_CAMPAIGN_SCHEMA,
  REQUIRED_CAMPAIGN_CHECKS,
  evaluateCampaignCorrectness,
  runPackagedMemoryCampaign,
} from "./packaged-memory-campaign.ts";
import {
  CampaignFailure,
  campaignAsBunRuntimeEvidence,
  normalizeCampaignError,
  type PackagedMemoryCampaignResult,
} from "./packaged-memory-campaign-contracts.ts";
import {
  decodeProductCallEnvelope,
  normalizeProductApiCode,
} from "./packaged-memory-campaign-read-path.ts";
import { summarizeRolePhysicalMemorySeries } from "./packaged-memory-campaign-evidence.ts";

describe("packaged memory campaign contract", () => {
  test("requires a real six-steady-cycle physical campaign", () => {
    expect(PACKAGED_MEMORY_CAMPAIGN_SCHEMA).toBe("butler.packaged-memory-campaign.v1");
    expect(typeof runPackagedMemoryCampaign).toBe("function");
  });

  test("settles public read teardown before measured refresh snapshots", () => {
    const source = readFileSync(
      new URL("./packaged-memory-campaign.ts", import.meta.url),
      "utf8",
    );
    const warmupStart = source.indexOf("for (let index = 0; index < warmupCycles");
    const steadyStart = source.indexOf("for (let index = 0; index < steadyCycles");
    const warmup = source.slice(warmupStart, steadyStart);
    const steady = source.slice(steadyStart);
    for (const block of [
      warmup,
      steady,
    ] as const) {
      const read = block.indexOf("exercisePublicReadPath");
      const settle = block.indexOf("settlePublicReadPathTeardown");
      const snapshot = block.indexOf("cycles.push(captureCampaignSnapshot", settle);
      expect(read).toBeGreaterThanOrEqual(0);
      expect(settle).toBeGreaterThan(read);
      expect(snapshot).toBeGreaterThan(settle);
    }
  });

  test("correctness is fail-closed for missing public checks and terminal failures", () => {
    expect(evaluateCampaignCorrectness(REQUIRED_CAMPAIGN_CHECKS, ["delivered"])).toBe(true);
    expect(evaluateCampaignCorrectness(REQUIRED_CAMPAIGN_CHECKS.slice(1), ["delivered"])).toBe(false);
    expect(evaluateCampaignCorrectness(REQUIRED_CAMPAIGN_CHECKS, ["failed"])).toBe(false);
    expect(evaluateCampaignCorrectness(REQUIRED_CAMPAIGN_CHECKS, ["unknown"])).toBe(false);
  });

  test("campaign evidence retains per-role physical samples without PIDs or commands", () => {
    const series = summarizeRolePhysicalMemorySeries([
      {
        capturedAt: new Date(1).toISOString(),
        platform: "darwin",
        processes: [{
          role: "embed",
          label: "embed-server",
          pid: 123,
          cpuPercent: null,
          cpuTimeMs: null,
          rssBytes: null,
          virtualSizeBytes: null,
          physicalFootprintBytes: 100,
          privateResidentBytes: null,
          compressedBytes: null,
          swapBytes: null,
          nativeHeapBytes: null,
          externalHeapBytes: null,
          openHandles: null,
          connections: null,
          unsupportedReasons: {},
        }],
        aggregate: {} as never,
        system: { compressedBytes: null, swapBytes: null, unsupportedReasons: {} },
        databases: [],
        cycle: { index: 0, phase: "steady", label: "refresh" },
      },
    ]);
    expect(series).toEqual([{
      role: "embed",
      label: "embed-server",
      samples: [{
        phase: "steady",
        cycleIndex: 0,
        physicalFootprintBytes: 100,
        privateResidentBytes: null,
        rssBytes: null,
      }],
    }]);
    expect(JSON.stringify(series)).not.toContain("123");
  });

  test("preserves typed read-path failure context without raw exception text", () => {
    const failure = new CampaignFailure(
      "campaign_public_read_failed",
      "step=cursor-resync;api=session_cursor_resync_required",
    );
    expect(normalizeCampaignError(failure)).toEqual({
      code: "campaign_public_read_failed",
      detail: "step=cursor-resync;api=session_cursor_resync_required",
    });
    expect(normalizeCampaignError(new Error("/Users/private/prompt-secret"), "campaign_public_read_failed"))
      .toEqual({ code: "campaign_public_read_failed", detail: "campaign step failed" });
  });

  test("decodes product errors across the CDP boundary as a structured envelope", () => {
    expect(decodeProductCallEnvelope({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "session_cursor_resync_required",
        status: 409,
        resync: {
          required: true,
          resource: "session-view",
          reason: "cursor-expired",
        },
      },
    })).toEqual({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "session_cursor_resync_required",
        status: 409,
        resync: {
          required: true,
          resource: "session-view",
          reason: "cursor-expired",
        },
      },
    });
    expect(decodeProductCallEnvelope({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "session_cursor_resync_required",
        resync: {
          required: true,
          resource: "session-view",
          reason: "cursor-expired",
        },
      },
    })).toEqual({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "session_cursor_resync_required",
        resync: {
          required: true,
          resource: "session-view",
          reason: "cursor-expired",
        },
      },
    });
    expect(decodeProductCallEnvelope({
      ok: true,
      data: { session_id: "session" },
    })).toEqual({ ok: true, value: { session_id: "session" } });
    expect(normalizeProductApiCode("path:/private/worktree")).toBe("request_failed");
    expect(decodeProductCallEnvelope({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "request_failed",
        message: "/private/worktree/prompt-secret",
      },
    })).toEqual({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "request_failed",
      },
    });
    expect(decodeProductCallEnvelope({
      ok: false,
      error: { code: "session_cursor_resync_required" },
    })).toEqual({
      ok: false,
      error: {
        schema: "butler.app.bridge-error.v1",
        code: "invalid_protocol",
      },
    });
  });

  test("retains privacy-safe failure context in Bun runtime evidence", () => {
    const result = {
      schema: PACKAGED_MEMORY_CAMPAIGN_SCHEMA,
      ok: false,
      variant: "pinned",
      runtime: {
        executableName: "bun",
        bunVersion: "1.3.11",
        managedExecutableName: "bun",
        managedBunVersion: "1.3.11",
        bundledExecutableName: "bun",
        bundledBunVersion: "1.3.11",
      },
      sourceFingerprint: "source",
      dataFingerprint: "data",
      cacheFingerprint: "",
      cachePolicy: "fresh-isolated-runtime-model-cache-v1",
      cacheResourceDigest: "",
      modelCacheDigest: "",
      warmupCycles: 3,
      steadyCycles: 6,
      processTargets: [],
      cycles: [],
      idle: null,
      idleReclamation: null,
      physicalGate: {
        ok: false,
        failures: ["fixture failed"],
        metrics: {
          steadyCycleCount: 0,
          firstThreeMedianBytes: null,
          finalThreeMedianBytes: null,
          finalVsFirstRatio: null,
          memoryValues: [],
          resourceValues: [],
          memorySource: null,
          embedBaselineBytes: null,
          embedLoadedBytes: null,
          embedAfterIdleBytes: null,
        },
        unsupportedReasons: [],
      },
      correctness: { ok: false, checks: ["provider-terminal"] },
      archiveStream: { ok: false, reason: "not supplied", attempts: 0, successes: 0 },
      packaging: { ok: false, reason: "not supplied", attempts: 0, successes: 0 },
      providerTerminalStates: ["delivered"],
      error: {
        code: "campaign_public_read_failed",
        detail: "step=cursor-resync;api=session_cursor_resync_required",
      },
    } satisfies PackagedMemoryCampaignResult;
    expect(campaignAsBunRuntimeEvidence(result).error).toEqual(result.error);
  });
});

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionAgentAdapters } from
  "../../support/agent-benchmark/adapters.ts";
import { createButlerAdapter } from
  "../../support/agent-benchmark/butler-adapter.ts";
import type { BenchmarkArmPlan, BenchmarkFixture } from
  "../../support/agent-benchmark/contracts.ts";
import type { PreparedButlerResourceReference } from
  "../../support/agent-benchmark/prepared-butler-resource.ts";

test("production composition rejects an invalid prepared resource without packaging fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-prepared-composition-"));
  try {
    const sourceRoot = process.cwd();
    const evidenceRoot = join(root, "evidence");
    const sourceRevision = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const prepared: PreparedButlerResourceReference = {
      resourceDir: join(root, "missing-resource"),
      sourceRevision,
      sourceCompatibilitySha256: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      dependencyClosureSha256: "a".repeat(64),
      resourceSha256: "e".repeat(64),
      resourceBytes: 1,
      archiveSha256: "d".repeat(64),
      archiveBytes: 1,
    };
    const adapter = createProductionAgentAdapters(sourceRoot, {
      preparedButlerResource: prepared,
    }).butler;
    const result = await adapter.run({
      arm: arm(sourceRoot, evidenceRoot, prepared.sourceRevision),
      fixture: fixture(),
      prompt: "unused",
      sessionId: null,
      sourceEvidenceRoot: "",
      runtimeInstructions: "unused",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      gateCode: "measurement_unavailable",
      exitCode: null,
    });
    expect(result.stderr).toContain("prepared_resource_missing");
    expect(result.stderr).not.toContain(root);
    expect(Bun.file(join(evidenceRoot, "bundled-agent-resource")).size).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderer launch-smoke evidence bypasses turn-only M1 collection", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-renderer-smoke-adapter-"));
  try {
    const sourceRoot = process.cwd();
    const sourceRevision = execFileSync(
      "git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
    ).trim();
    const adapter = createButlerAdapter(async () => ({
      kind: "launch_smoke",
      ok: true,
      observations: [],
      providerRequests: [],
      run: { dataRoot: join(root, "data"), workspaceRoot: join(root, "workspace") },
    }), sourceRoot);
    const result = await adapter.run({
      arm: arm(sourceRoot, join(root, "evidence"), sourceRevision),
      fixture: fixture(),
      prompt: "unused",
      sessionId: null,
      sourceEvidenceRoot: "",
      runtimeInstructions: "unused",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: 0, gateCode: "none" });
    expect(result.m1V2Evidence).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function arm(
  sourceRoot: string,
  evidenceRoot: string,
  sourceRevision: string,
): BenchmarkArmPlan {
  return {
    key: "current-web-cold:controlled:butler:1",
    scenario: "current-web-cold",
    repetition: 1,
    order: 1,
    agent: "butler",
    track: "controlled",
    cache: "cold",
    fixtureHash: "fixture",
    effectiveConfig: {
      model: "local/test-model",
      reasoning: "medium",
      permissions: "full_access",
      tools: [],
      memoryEnabled: null,
      skillsEnabled: null,
      pluginsEnabled: null,
      mcpEnabled: null,
      provider: "local",
      variant: null,
    },
    sourceRoot,
    outputRoot: join(evidenceRoot, "output"),
    dataRoot: join(evidenceRoot, "benchmark-data"),
    evidenceRoot,
    cacheRoot: join(evidenceRoot, "cache"),
    cachePairId: "current-web-cold:1",
    timeoutMs: 1_000,
    sourceRevision,
  };
}

function fixture(): BenchmarkFixture {
  return {
    id: "current-web-cold",
    version: "test",
    prompts: ["unused"],
    m1V2: {
      armId: "current-web-cold",
      scenario: {
        schema: "butler.btcc-r3-electron-scenario.v1",
        id: "current-web-cold",
        model: "local/test-model",
        attributionArmId: "current-web-cold",
        steps: [{ id: "current-web-cold", prompt: "unused" }],
      },
      targetStepId: "current-web-cold",
      publicBenchmarkFixture: true,
      promptSha256: {},
      fixtureSha256: {},
    },
  };
}

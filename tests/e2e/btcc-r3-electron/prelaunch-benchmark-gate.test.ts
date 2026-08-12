import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createButlerAdapter,
  createElectronButlerRunner,
} from "../../support/agent-benchmark/butler-adapter.ts";
import type { BenchmarkArmPlan } from
  "../../support/agent-benchmark/contracts.ts";
import { evaluateAdapterResult } from
  "../../support/agent-benchmark/evaluators.ts";
import { loadM1V2BenchmarkFixtures } from
  "../../support/agent-benchmark/fixtures.ts";

test("Electron runner failure is recovered by the Butler adapter and evaluator", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-prelaunch-gate-"));
  const repoRoot = join(root, "repo");
  const sourceData = join(root, "source-data");
  const runRoot = join(root, "run");
  const previewHost = join(
    repoRoot,
    "packages/butler-app/client/electron/local-page-preview-host.mjs",
  );
  mkdirSync(join(repoRoot, "packages/butler-app/client/electron"), { recursive: true });
  writeFileSync(previewHost, "export {};\n", "utf8");
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({
    version: "test-butler",
  }), "utf8");
  mkdirSync(sourceData, { recursive: true });
  writeFileSync(join(sourceData, "butler.config.json"), JSON.stringify({
    models: { registered: [] },
    system: { butlerModel: "local/test-model", defaultModel: "local/test-model" },
  }), "utf8");
  const previousTmpDir = process.env.TMPDIR;
  const previousSourceData = process.env.BUTLER_E2E_SOURCE_DATA;
  process.env.TMPDIR = join(root, "unavailable-package-staging-volume");
  process.env.BUTLER_E2E_SOURCE_DATA = sourceData;
  try {
    const fixture = loadM1V2BenchmarkFixtures(process.cwd()).find(
      (candidate) => candidate.id === "current-web-cold",
    )!;
    const arm: BenchmarkArmPlan = {
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
      sourceRoot: repoRoot,
      outputRoot: join(root, "output"),
      dataRoot: join(root, "benchmark-data"),
      evidenceRoot: runRoot,
      cacheRoot: join(root, "cache"),
      cachePairId: "current-web-cold:1",
      timeoutMs: 1_000,
      sourceRevision: "test-source",
    };
    const adapter = createButlerAdapter(createElectronButlerRunner(), repoRoot);
    const result = await adapter.run({
      arm,
      fixture,
      prompt: fixture.prompts[0]!,
      sessionId: null,
      sourceEvidenceRoot: "",
      runtimeInstructions: "bounded local test",
      signal: new AbortController().signal,
      benchmarkEvidence: { planIdentity: "a".repeat(64), runRoot: arm.evidenceRoot },
    });
    expect(result).toMatchObject({
      exitCode: null,
      gateCode: "measurement_unavailable",
      timedOut: false,
      stderr: "Butler Electron/App setup did not reach a product launch " +
        "(stage=bundled_agent_preparation, cause=resource_inspection_failed, " +
        "owner=electron_harness, exitCode=null, signal=null).",
    });
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain("availableBytes");
    const persisted = JSON.parse(
      await Bun.file(join(runRoot, "evidence.json")).text(),
    ) as { failure?: { requiredBytes?: number } };
    expect(persisted.failure?.requiredBytes).toBe(2 * 1024 * 1024 * 1024);
    const observation = evaluateAdapterResult(arm, fixture, result);
    expect(observation.terminalState).toBe("gated");
    expect(observation.gateCode).toBe("measurement_unavailable");
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    if (previousSourceData === undefined) delete process.env.BUTLER_E2E_SOURCE_DATA;
    else process.env.BUTLER_E2E_SOURCE_DATA = previousSourceData;
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAgentAdapters, createProductionAgentAdapters } from
  "../../support/agent-benchmark/adapters.ts";
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
      benchmarkEvidence: { planIdentity: "a".repeat(64), runRoot: evidenceRoot },
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
    const evidenceRoot = join(root, "evidence");
    const dataRoot = join(evidenceRoot, "data");
    mkdirSync(join(dataRoot, "app-server"), { recursive: true });
    mkdirSync(join(dataRoot, "runtime"), { recursive: true });
    const appDb = new Database(join(dataRoot, "app-server", "butler-client.sqlite"));
    appDb.exec(`
      CREATE TABLE turns (id TEXT);
      CREATE TABLE btcc_turns (id TEXT);
      CREATE TABLE btcc_model_route_events (id TEXT);
      CREATE TABLE btcc_model_round_acceptances (id TEXT);
    `);
    appDb.close();
    const conversationDb = new Database(join(dataRoot, "runtime", "conversation-store.sqlite"));
    conversationDb.exec("CREATE TABLE conversation_turns (id TEXT)");
    conversationDb.close();
    const sourceRevision = execFileSync(
      "git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
    ).trim();
    const adapter = createAgentAdapters({
      sourceRoot,
      commandExecutor: { execute: async () => { throw new Error("external adapter must not run"); } },
      butlerRunner: async () => ({
        kind: "launch_smoke",
        ok: true,
        actualProductPath: [
          "electron_renderer",
          "electron_preload_bridge",
          "app_gateway",
          "native_btcc_runtime",
        ],
        launches: [
          { electronPid: 101, executorPid: 201, interruptedExecutorReplaced: false, startedAtMs: 1, stoppedAtMs: 2 },
          { electronPid: 102, executorPid: 202, interruptedExecutorReplaced: false, startedAtMs: 3, stoppedAtMs: 4 },
        ],
        observations: [],
        providerRequests: [],
        run: { dataRoot, workspaceRoot: join(evidenceRoot, "workspace") },
      }),
    }).butler;
    const result = await adapter.run({
      arm: arm(sourceRoot, evidenceRoot, sourceRevision),
      fixture: fixture(),
      prompt: "unused",
      sessionId: null,
      sourceEvidenceRoot: "",
      runtimeInstructions: "unused",
      signal: new AbortController().signal,
      benchmarkEvidence: { planIdentity: "a".repeat(64), runRoot: root },
    });
    expect(result).toMatchObject({ exitCode: 0, gateCode: "none" });
    expect(result.m1V2Evidence).toBeUndefined();
    expect(existsSync(dataRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup decision reason classifies observed SC01 as measurement and ambiguity as configuration", async () => {
  for (const [caseName, mutate, gateCode] of [
    ["sc01", (dataRoot: string) => {
      const metrics = join(dataRoot, "metrics");
      mkdirSync(metrics);
      writeFileSync(join(metrics, "operational-events.jsonl"), `${JSON.stringify({ name: "m1_v2_request_envelope" })}\n`);
    }, "measurement_unavailable"],
    ["route", (dataRoot: string) => {
      const db = new Database(join(dataRoot, "app-server", "butler-client.sqlite"));
      db.exec("INSERT INTO btcc_model_route_events VALUES ('route-safe')");
      db.close();
    }, "measurement_unavailable"],
    ["round", (dataRoot: string) => {
      const db = new Database(join(dataRoot, "app-server", "butler-client.sqlite"));
      db.exec("INSERT INTO btcc_model_round_acceptances VALUES ('round-safe')");
      db.close();
    }, "measurement_unavailable"],
    ["ambiguous", (dataRoot: string) => {
      rmSync(join(dataRoot, "runtime", "conversation-store.sqlite"));
    }, "configuration_unverifiable"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `butler-cleanup-${caseName}-`));
    try {
      const sourceRoot = process.cwd();
      const evidenceRoot = join(root, "evidence");
      const dataRoot = join(evidenceRoot, "data");
      createRuntimeAuthority(dataRoot);
      mutate(dataRoot);
      const adapter = createAgentAdapters({
        sourceRoot,
        commandExecutor: { execute: async () => { throw new Error("external adapter must not run"); } },
        butlerRunner: async () => launchSmokeEvidence(dataRoot, evidenceRoot),
      }).butler;
      const result = await adapter.run({
        arm: arm(sourceRoot, evidenceRoot, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()),
        fixture: fixture(), prompt: "unused", sessionId: null, sourceEvidenceRoot: "",
        runtimeInstructions: "unused", signal: new AbortController().signal,
        benchmarkEvidence: { planIdentity: "a".repeat(64), runRoot: root },
      });
      expect(result.gateCode).toBe(gateCode);
      expect(existsSync(dataRoot)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createRuntimeAuthority(dataRoot: string): void {
  mkdirSync(join(dataRoot, "app-server"), { recursive: true });
  mkdirSync(join(dataRoot, "runtime"), { recursive: true });
  const appDb = new Database(join(dataRoot, "app-server", "butler-client.sqlite"));
  appDb.exec("CREATE TABLE turns(id TEXT); CREATE TABLE btcc_turns(id TEXT); CREATE TABLE btcc_model_route_events(id TEXT); CREATE TABLE btcc_model_round_acceptances(id TEXT)");
  appDb.close();
  const conversationDb = new Database(join(dataRoot, "runtime", "conversation-store.sqlite"));
  conversationDb.exec("CREATE TABLE conversation_turns(id TEXT)");
  conversationDb.close();
}

function launchSmokeEvidence(dataRoot: string, evidenceRoot: string): Record<string, unknown> {
  return {
    kind: "launch_smoke", ok: true,
    actualProductPath: ["electron_renderer", "electron_preload_bridge", "app_gateway", "native_btcc_runtime"],
    launches: [{ startedAtMs: 1, stoppedAtMs: 2 }, { startedAtMs: 3, stoppedAtMs: 4 }],
    observations: [], providerRequests: [], run: { dataRoot, workspaceRoot: join(evidenceRoot, "workspace") },
  };
}

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

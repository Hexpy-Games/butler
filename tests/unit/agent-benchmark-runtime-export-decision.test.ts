import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { decideButlerRuntimeExport } from
  "../support/agent-benchmark/butler-runtime-export-decision.ts";
import { cleanupButlerRuntime } from
  "../support/agent-benchmark/butler-runtime-cleanup.ts";

test("verified non-turn launch smoke is the only M1 operation allowed without SC01 export", () => {
  const fixture = launchSmokeFixture();
  expect(decideButlerRuntimeExport({
    evidence: fixture.evidence,
    durableExport: "missing_or_failed",
  })).toEqual({ cleanupAllowed: true, reason: "verified_non_turn_launch_smoke" });

  for (const evidence of [
    { ...fixture.evidence, providerRequests: [{ ordinal: 1 }] },
    { ...fixture.evidence, observations: [{ turnId: "turn-safe" }] },
    { ...fixture.evidence, providerRequests: undefined },
    { ...fixture.evidence, observations: undefined },
    { ...fixture.evidence, kind: "scenario_run" },
    { ...fixture.evidence, actualProductPath: [
      "electron_renderer", "electron_renderer", "app_gateway", "native_btcc_runtime",
    ] },
  ]) {
    expect(decideButlerRuntimeExport({ evidence, durableExport: "missing_or_failed" }).cleanupAllowed)
      .toBeFalse();
  }
});

test("runtime absence is idempotent only after verified export or for not-armed cleanup", () => {
  const fixture = launchSmokeFixture();
  const arm = cleanupArm(fixture);
  expect(cleanupButlerRuntime(fixture.evidence, arm, "missing_or_failed").status)
    .toBe("removed");
  expect(existsSync(fixture.dataRoot)).toBeFalse();
  expect(existsSync(join(fixture.evidenceRoot, "sc01-public-evidence.json"))).toBeFalse();
  expect(cleanupButlerRuntime(fixture.evidence, arm, "missing_or_failed"))
    .toMatchObject({ status: "failed", reason: "runtime_observation_ambiguous" });
  expect(cleanupButlerRuntime(fixture.evidence, arm, "verified").status).toBe("absent");
  expect(cleanupButlerRuntime(fixture.evidence, arm, "not_armed").status).toBe("absent");
});

test("missing M1 runtime cannot bypass typed launch and authority verification", () => {
  const fixture = launchSmokeFixture();
  const arm = cleanupArm(fixture);
  const emptyRoot = { ...fixture.evidence, run: { ...fixture.evidence.run as object, dataRoot: "" } };
  expect(cleanupButlerRuntime(emptyRoot, arm, "missing_or_failed"))
    .toMatchObject({ status: "failed", reason: "runtime_observation_ambiguous" });

  rmSync(fixture.dataRoot, { recursive: true });
  const incomplete = { ...fixture.evidence, launches: [] };
  expect(cleanupButlerRuntime(incomplete, arm, "missing_or_failed"))
    .toMatchObject({ status: "failed", reason: "runtime_observation_ambiguous" });

  const errorRoot = mkdtempSync(join(tmpdir(), "butler-cleanup-lstat-error-"));
  const evidenceRoot = join(errorRoot, "evidence");
  mkdirSync(evidenceRoot);
  symlinkSync("loop", join(evidenceRoot, "loop"));
  const errorEvidence = { ...fixture.evidence, run: {
    ...fixture.evidence.run as object,
    dataRoot: join(evidenceRoot, "loop", "data"),
  } };
  expect(cleanupButlerRuntime(errorEvidence, {
    ...arm,
    evidenceRoot,
  }, "missing_or_failed")).toMatchObject({
    status: "failed",
    reason: "runtime_observation_ambiguous",
  });
});

test("Turn, route, accepted-round, and SC01 rows each require verified export", () => {
  for (const table of ["turns", "btcc_turns", "conversation_turns", "btcc_model_route_events", "btcc_model_round_acceptances"] as const) {
    const fixture = launchSmokeFixture();
    const databasePath = table === "conversation_turns"
      ? join(fixture.dataRoot, "runtime", "conversation-store.sqlite")
      : join(fixture.dataRoot, "app-server", "butler-client.sqlite");
    const db = new Database(databasePath);
    db.exec(`INSERT INTO ${table} VALUES ('safe')`);
    db.close();
    expect(decideButlerRuntimeExport({ evidence: fixture.evidence, durableExport: "missing_or_failed" }))
      .toEqual({ cleanupAllowed: false, reason: "durable_export_required" });
    expect(decideButlerRuntimeExport({ evidence: fixture.evidence, durableExport: "verified" }).cleanupAllowed)
      .toBeTrue();
  }

  for (const name of ["m1_v2_request_envelope", "m1_v2_request_segment", "m1_v2_response_usage"]) {
    const fixture = launchSmokeFixture();
    const metrics = join(fixture.dataRoot, "metrics");
    mkdirSync(metrics);
    writeFileSync(join(metrics, "operational-events.jsonl"), `${JSON.stringify({ name })}\n`);
    expect(decideButlerRuntimeExport({ evidence: fixture.evidence, durableExport: "missing_or_failed" }))
      .toEqual({ cleanupAllowed: false, reason: "durable_export_required" });
  }
});

test("partial restart and ambiguous runtime counters fail closed", () => {
  const partial = launchSmokeFixture();
  partial.evidence.launches = (partial.evidence.launches as unknown[]).slice(0, 1);
  expect(decideButlerRuntimeExport({ evidence: partial.evidence, durableExport: "missing_or_failed" }))
    .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });
  expect(cleanupButlerRuntime(partial.evidence, cleanupArm(partial), "missing_or_failed").status)
    .toBe("failed");
  expect(existsSync(partial.dataRoot)).toBeTrue();

  const unstopped = launchSmokeFixture();
  ((unstopped.evidence.launches as Array<Record<string, unknown>>)[1]!).stoppedAtMs = null;
  expect(decideButlerRuntimeExport({ evidence: unstopped.evidence, durableExport: "missing_or_failed" }))
    .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });

  const malformedMetric = launchSmokeFixture();
  const metrics = join(malformedMetric.dataRoot, "metrics");
  mkdirSync(metrics);
  writeFileSync(join(metrics, "operational-events.jsonl"), "not-json\n");
  expect(decideButlerRuntimeExport({ evidence: malformedMetric.evidence, durableExport: "missing_or_failed" }))
    .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });

  const missingAuthority = launchSmokeFixture();
  const db = new Database(join(missingAuthority.dataRoot, "runtime", "conversation-store.sqlite"));
  db.exec("DROP TABLE conversation_turns");
  db.close();
  expect(decideButlerRuntimeExport({ evidence: missingAuthority.evidence, durableExport: "missing_or_failed" }))
    .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });

  const forgedBackup = launchSmokeFixture();
  rmSync(join(forgedBackup.dataRoot, "app-server", "butler-client.sqlite"));
  const backup = new Database(join(forgedBackup.dataRoot, "backup.sqlite"));
  backup.exec(`
    CREATE TABLE turns (id TEXT);
    CREATE TABLE btcc_turns (id TEXT);
    CREATE TABLE btcc_model_route_events (id TEXT);
    CREATE TABLE btcc_model_round_acceptances (id TEXT);
  `);
  backup.close();
  expect(decideButlerRuntimeExport({ evidence: forgedBackup.evidence, durableExport: "missing_or_failed" }))
    .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });

  const malformedDatabase = launchSmokeFixture();
  writeFileSync(join(malformedDatabase.dataRoot, "app-server", "butler-client.sqlite"), "not-sqlite");
  expect(decideButlerRuntimeExport({ evidence: malformedDatabase.evidence, durableExport: "missing_or_failed" }))
    .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });

  for (const component of ["app-server", "runtime", "metrics"] as const) {
    const symlinked = launchSmokeFixture();
    const external = mkdtempSync(join(tmpdir(), `butler-${component}-external-`));
    const componentPath = join(symlinked.dataRoot, component);
    rmSync(componentPath, { recursive: true, force: true });
    if (component === "app-server") {
      const db = new Database(join(external, "butler-client.sqlite"));
      db.exec("CREATE TABLE turns(id TEXT); CREATE TABLE btcc_turns(id TEXT); CREATE TABLE btcc_model_route_events(id TEXT); CREATE TABLE btcc_model_round_acceptances(id TEXT)");
      db.close();
    } else if (component === "runtime") {
      const db = new Database(join(external, "conversation-store.sqlite"));
      db.exec("CREATE TABLE conversation_turns(id TEXT)");
      db.close();
    } else {
      writeFileSync(join(external, "operational-events.jsonl"), "");
    }
    symlinkSync(external, componentPath);
    expect(decideButlerRuntimeExport({ evidence: symlinked.evidence, durableExport: "missing_or_failed" }))
      .toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });
  }

  const emptyMetricsTarget = launchSmokeFixture();
  const emptyExternal = mkdtempSync(join(tmpdir(), "butler-empty-metrics-external-"));
  rmSync(join(emptyMetricsTarget.dataRoot, "metrics"), { recursive: true, force: true });
  symlinkSync(emptyExternal, join(emptyMetricsTarget.dataRoot, "metrics"));
  expect(decideButlerRuntimeExport({
    evidence: emptyMetricsTarget.evidence,
    durableExport: "missing_or_failed",
  })).toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });

  const danglingMetricsTarget = launchSmokeFixture();
  const absentExternal = join(danglingMetricsTarget.root, "absent-external-metrics");
  rmSync(join(danglingMetricsTarget.dataRoot, "metrics"), { recursive: true, force: true });
  symlinkSync(absentExternal, join(danglingMetricsTarget.dataRoot, "metrics"));
  expect(decideButlerRuntimeExport({
    evidence: danglingMetricsTarget.evidence,
    durableExport: "missing_or_failed",
  })).toEqual({ cleanupAllowed: false, reason: "runtime_observation_ambiguous" });
});

test("an observed SC01 campaign cannot use the not-armed cleanup state", () => {
  const fixture = launchSmokeFixture();
  const metrics = join(fixture.dataRoot, "metrics");
  mkdirSync(metrics);
  writeFileSync(join(metrics, "operational-events.jsonl"),
    `${JSON.stringify({ name: "m1_v2_request_envelope" })}\n`);
  expect(decideButlerRuntimeExport({ evidence: fixture.evidence, durableExport: "not_armed" }))
    .toEqual({ cleanupAllowed: false, reason: "durable_export_required" });
});

test("not-armed cleanup preserves legacy runtime semantics while metrics stay fail-closed", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-non-m1-cleanup-"));
  const evidenceRoot = join(root, "evidence");
  const dataRoot = join(evidenceRoot, "data");
  mkdirSync(dataRoot, { recursive: true });
  const evidence = { run: { dataRoot } };
  const arm = {
    evidenceRoot,
    outputRoot: join(root, "output"),
    cacheRoot: join(root, "cache"),
    dataRoot: join(root, "benchmark-data"),
    sourceRoot: join(root, "source"),
  };
  expect(cleanupButlerRuntime(evidence, arm, "not_armed").status).toBe("removed");

  mkdirSync(join(dataRoot, "metrics"), { recursive: true });
  writeFileSync(join(dataRoot, "metrics", "operational-events.jsonl"), "not-json\n");
  expect(cleanupButlerRuntime(evidence, arm, "not_armed").status).toBe("failed");
  expect(existsSync(dataRoot)).toBeTrue();
});

function launchSmokeFixture(): {
  root: string;
  evidenceRoot: string;
  dataRoot: string;
  evidence: Record<string, unknown>;
} {
  const root = mkdtempSync(join(tmpdir(), "butler-launch-cleanup-decision-"));
  const evidenceRoot = join(root, "evidence");
  const dataRoot = join(evidenceRoot, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(dataRoot, "app-server"));
  mkdirSync(join(dataRoot, "runtime"));
  const app = new Database(join(dataRoot, "app-server", "butler-client.sqlite"));
  app.exec(`
    CREATE TABLE turns (id TEXT);
    CREATE TABLE btcc_turns (id TEXT);
    CREATE TABLE btcc_model_route_events (id TEXT);
    CREATE TABLE btcc_model_round_acceptances (id TEXT);
  `);
  app.close();
  const conversation = new Database(join(dataRoot, "runtime", "conversation-store.sqlite"));
  conversation.exec("CREATE TABLE conversation_turns (id TEXT)");
  conversation.close();
  return {
    root,
    evidenceRoot,
    dataRoot,
    evidence: {
      kind: "launch_smoke",
      ok: true,
      actualProductPath: [
        "electron_renderer",
        "electron_preload_bridge",
        "app_gateway",
        "native_btcc_runtime",
      ],
      launches: [
        { startedAtMs: 1, stoppedAtMs: 2 },
        { startedAtMs: 3, stoppedAtMs: 4 },
      ],
      observations: [],
      providerRequests: [],
      run: { dataRoot },
    },
  };
}

function cleanupArm(fixture: ReturnType<typeof launchSmokeFixture>) {
  return {
    evidenceRoot: fixture.evidenceRoot,
    outputRoot: join(fixture.root, "output"),
    cacheRoot: join(fixture.root, "cache"),
    dataRoot: join(fixture.root, "benchmark-data"),
    sourceRoot: join(fixture.root, "source"),
  };
}

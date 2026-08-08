import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeSandyCorrectionCli,
  parseSandyCorrectionCli,
  readSandyCorrection,
  runSandyCorrection,
  redactSandyOwnerStopManifest,
  SANDY_CAPTURE_OBJECTIVE,
  SANDY_CAPTURE_TURN_IDS,
  SANDY_MONITORING_TURN_IDS,
  SANDY_SESSION_ID,
  SANDY_SOURCE_ACTION_KEYS,
  SANDY_SOURCE_OBJECTIVE,
  SANDY_SOURCE_PLAN_CHECKS,
  SANDY_SOURCE_PLAN_REVISION_ID,
  SANDY_SOURCE_SCOPE_REF,
  SANDY_SOURCE_WORK_ID,
  sha256,
  verifySandyOwnerStop,
  type SandyCorrectionInput,
} from "../../packages/butler-agent/src/operations/correction/index.ts";

const roots: string[] = [];
const sessionId = SANDY_SESSION_ID;
const sourceWorkId = SANDY_SOURCE_WORK_ID;
const monitoringTurnIds = SANDY_MONITORING_TURN_IDS;
const captureTurnIds = SANDY_CAPTURE_TURN_IDS;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Sandy correction product path", () => {
  test("dry-run is read-only and reports exact observed identity", () => {
    const fixture = createFixture();
    const input = correctionInput(fixture.dbPath);
    const before = readCounts(fixture.dbPath);
    const result = runSandyCorrection(input);
    expect(result.status).toBe("dry_run");
    expect(result.read.sourceBindingCount).toBe(4);
    expect(result.read.sourceResultCount).toBe(309);
    expect(result.read.monitoringResultCount).toBe(128);
    expect(result.read.captureResultCount).toBe(181);
    expect(readCounts(fixture.dbPath)).toEqual(before);
  });

  test("operator CLI defaults to dry-run and carries the explicit apply identity", () => {
    const fixture = createFixture();
    const observed = readSandyCorrection({ dbPath: fixture.dbPath, sessionId, sourceWorkId, monitoringTurnIds, captureTurnIds });
    const args = [
      "--db", fixture.dbPath,
      "--session", sessionId,
      "--source-work", sourceWorkId,
      "--monitoring-turn", monitoringTurnIds[0], "--monitoring-turn", monitoringTurnIds[1],
      "--capture-turn", captureTurnIds[0], "--capture-turn", captureTurnIds[1],
      "--expected-status", "open",
      "--expected-bindings", String(observed.sourceBindingCount),
      "--expected-results", String(observed.sourceResultCount),
      "--expected-binding-digest", observed.bindingDigest,
      "--expected-result-digest", observed.resultDigest,
      "--expected-db-sha256", observed.identity.sha256,
      "--expected-snapshot-sha256", observed.beforeSnapshotSha256,
    ];
    const parsedDryRun = parseSandyCorrectionCli(args);
    expect(executeSandyCorrectionCli(parsedDryRun).status).toBe("dry_run");
    const parsedApply = parseSandyCorrectionCli([
      ...args,
      "--apply", "--owner-stopped", "--backup-dir", join(fixture.root, "cli-backups"),
      "--operator-id", "test-operator", "--reason", "Copied database rehearsal",
    ]);
    expect(executeSandyCorrectionCli(parsedApply).status).toBe("applied");
  });

  test("rejects wrong database identity/count without mutation", () => {
    const fixture = createFixture();
    const input = correctionInput(fixture.dbPath, {
      expected: { ...correctionInput(fixture.dbPath).expected, resultCount: 308 },
    });
    expect(() => runSandyCorrection(input)).toThrow(/result count mismatch/);
    expect(readCounts(fixture.dbPath)).toEqual({ works: 1, bindings: 4, results: 309, audits: 0 });
  });

  test("rejects wrong session or Work identity before opening a write transaction", () => {
    const fixture = createFixture();
    const original = correctionInput(fixture.dbPath);
    expect(() => runSandyCorrection({ ...original, sessionId: "wrong-session" })).toThrow(/immutable Sandy recipe/);
    expect(() => runSandyCorrection({ ...original, sourceWorkId: "wrong-work" })).toThrow(/immutable Sandy recipe/);
    expect(readCounts(fixture.dbPath)).toEqual({ works: 1, bindings: 4, results: 309, audits: 0 });
  });

  test("applies exact split atomically, preserves sequence order, and is idempotent", () => {
    const fixture = createFixture();
    const input = correctionInput(fixture.dbPath, {
      apply: true,
      ownerStopped: true,
      backupDir: join(fixture.root, "backups"),
    });
    const applied = runSandyCorrection(input);
    expect(applied.status).toBe("applied");
    expect(applied.after).toMatchObject({
      monitoringBindingCount: 2,
      captureBindingCount: 2,
      monitoringResultCount: 128,
      captureResultCount: 181,
      monitoringResultSequence: Array.from({ length: 128 }, (_, index) => index + 1),
      captureResultSequence: Array.from({ length: 181 }, (_, index) => index + 1),
    });
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.query<{ status: string }, [string]>("SELECT status FROM btcc_guided_works WHERE work_id = ?").get(sourceWorkId)?.status).toBe("completed");
      expect(db.query<{ status: string }, [string]>("SELECT status FROM btcc_guided_works WHERE work_id <> ?").get(sourceWorkId)?.status).toBe("open");
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_operator_correction_audits").get()?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions WHERE work_id = ?").get(sourceWorkId)?.count).toBe(1);
      const disposition = db.query<{
        disposition: string;
        action_updates_json: string;
        evidence_snapshot_json: string;
        followups_json: string;
      }, [string]>(`SELECT disposition, action_updates_json, evidence_snapshot_json, followups_json
        FROM btcc_guided_work_disposition_revisions WHERE work_id = ?`).get(sourceWorkId);
      expect(disposition?.disposition).toBe("completed");
      expect(JSON.parse(disposition?.action_updates_json ?? "[]")).toEqual(
        SANDY_SOURCE_ACTION_KEYS.map((actionKey) => expect.objectContaining({ actionKey, status: "done" })),
      );
      expect(JSON.parse(disposition?.evidence_snapshot_json ?? "{}")).toMatchObject({ judgeSamples: 57 });
      expect(JSON.parse(disposition?.followups_json ?? "[]")).toHaveLength(2);
      expect(db.query<{ work_id: string }, [string]>("SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?").get(sessionId)?.work_id).not.toBe(sourceWorkId);
      const captureWork = db.query<{
        work_id: string;
        objective: string;
        status: string;
        current_plan_revision_id: string | null;
      }, [string]>("SELECT work_id, objective, status, current_plan_revision_id FROM btcc_guided_works WHERE work_id <> ?").get(sourceWorkId);
      expect(captureWork).toMatchObject({
        objective: SANDY_CAPTURE_OBJECTIVE,
        status: "open",
      });
      expect(captureWork?.current_plan_revision_id).toBeString();
      const plan = db.query<{
        objective: string;
        actions_json: string;
        origin_turn_id: string;
      }, [string]>("SELECT objective, actions_json, origin_turn_id FROM btcc_guided_work_plan_revisions WHERE work_id = ?").get(captureWork!.work_id);
      expect(plan).toMatchObject({ origin_turn_id: captureTurnIds[0] });
      expect(JSON.parse(plan?.actions_json ?? "[]")).toHaveLength(2);
      expect(JSON.parse(plan?.actions_json ?? "[]")[0]).toMatchObject({ actionKey: "disable-capture-without-proxy" });
      const checkpoint = db.query<{
        stage: string;
        public_summary: string;
        next_step: string;
        action_states_json: string;
        origin_turn_id: string;
      }, [string]>("SELECT stage, public_summary, next_step, action_states_json, origin_turn_id FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?").get(captureWork!.work_id);
      expect(checkpoint).toMatchObject({ stage: "execution", origin_turn_id: captureTurnIds[1] });
      expect(checkpoint?.public_summary).toContain("uncommitted");
      expect(checkpoint?.public_summary).toContain("excluded as contaminated fallback");
      expect(JSON.parse(checkpoint?.action_states_json ?? "[]")).toMatchObject([
        { actionKey: "disable-capture-without-proxy", status: "done" },
        { actionKey: "harden-capture-screen-safety", status: "active" },
      ]);
      const sourceCheckpoint = db.query<{
        revision: number;
        result_sequence: number;
        action_states_json: string;
      }, [string]>(`SELECT revision, result_sequence, action_states_json
        FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ? ORDER BY revision DESC LIMIT 1`).get(sourceWorkId);
      expect(sourceCheckpoint).toMatchObject({ revision: 10, result_sequence: 128 });
      const closeoutStates = JSON.parse(sourceCheckpoint?.action_states_json ?? "[]");
      expect(closeoutStates).toEqual(
        SANDY_SOURCE_ACTION_KEYS.map((actionKey) => expect.objectContaining({ actionKey, status: "done" })),
      );
      expect(closeoutStates[3].note).toContain("57개 표본");
      expect(closeoutStates[3].note).not.toContain("0건");
      expect(rawJournalCount(db)).toBe(317);
      const audit = db.query<{
        before_snapshot_sha256: string;
        after_snapshot_sha256: string;
        before_snapshot_json: string;
        after_snapshot_json: string;
        backup_json: string;
        operator_id: string;
        backup_identity: string;
      }, []>(`SELECT before_snapshot_sha256, after_snapshot_sha256, before_snapshot_json,
        after_snapshot_json, backup_json, operator_id, backup_identity FROM btcc_operator_correction_audits`).get();
      expect(audit?.before_snapshot_sha256).toHaveLength(64);
      expect(audit?.after_snapshot_sha256).toHaveLength(64);
      expect(JSON.parse(audit?.before_snapshot_json ?? "{}")).toMatchObject({ resultCount: 309 });
      expect(JSON.parse(audit?.after_snapshot_json ?? "{}")).toMatchObject({ captureResultCount: 181 });
      expect(JSON.parse(audit?.backup_json ?? "{}")).toMatchObject({ sqliteSnapshotSha256: expect.any(String) });
      expect(audit?.operator_id).toBe("test-operator");
      expect(audit?.backup_identity).toHaveLength(64);
      expect(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      db.close();
    }
    const replay = runSandyCorrection(input);
    expect(replay.status).toBe("already_applied");
    expect(readCounts(fixture.dbPath)).toEqual({ works: 2, bindings: 4, results: 309, audits: 1 });
  });

  test("rolls back all semantic writes when a result update trigger aborts", () => {
    const fixture = createFixture();
    const db = new Database(fixture.dbPath);
    db.exec("CREATE TRIGGER fail_sandy_result_move BEFORE UPDATE OF work_id ON btcc_guided_work_results BEGIN SELECT RAISE(ABORT, 'rehearsal failure'); END");
    db.close();
    const input = correctionInput(fixture.dbPath, {
      apply: true,
      ownerStopped: true,
      backupDir: join(fixture.root, "backups"),
    });
    expect(() => runSandyCorrection(input)).toThrow(/rehearsal failure/);
    expect(readCounts(fixture.dbPath)).toEqual({ works: 1, bindings: 4, results: 309, audits: 0 });
    const verify = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(verify.query<{ status: string }, [string]>("SELECT status FROM btcc_guided_works WHERE work_id = ?").get(sourceWorkId)?.status).toBe("open");
      expect(verify.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'btcc_guided_work_disposition_revisions'").get()?.count).toBe(0);
    } finally {
      verify.close();
    }
  });

  test("keeps the audit append-only", () => {
    const fixture = createFixture();
    const input = correctionInput(fixture.dbPath, {
      apply: true,
      ownerStopped: true,
      backupDir: join(fixture.root, "backups"),
    });
    runSandyCorrection(input);
    const db = new Database(fixture.dbPath);
    try {
      expect(() => db.query("UPDATE btcc_operator_correction_audits SET operator_reason = 'tamper'").run()).toThrow(/immutable/);
      expect(() => db.query("DELETE FROM btcc_operator_correction_audits").run()).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });

  test("rejects apply without an immutable operator identity, reason, or backup", () => {
    const fixture = createFixture();
    const input = correctionInput(fixture.dbPath, { apply: true, ownerStopped: true });
    expect(() => runSandyCorrection({ ...input, operatorId: undefined })).toThrow(/operatorId/);
    expect(() => runSandyCorrection({ ...input, operatorReason: "" })).toThrow(/operatorReason/);
    expect(readCounts(fixture.dbPath)).toEqual({ works: 1, bindings: 4, results: 309, audits: 0 });
  });

  test("rolls back when a same-count binding mutation changes a result identity", () => {
    const fixture = createFixture();
    const db = new Database(fixture.dbPath);
    db.exec(`CREATE TRIGGER mutate_sandy_result_same_count
      AFTER UPDATE OF work_id ON btcc_guided_turn_work_bindings
      WHEN NEW.turn_id = '${captureTurnIds[0]}'
      BEGIN
        UPDATE btcc_guided_work_results SET attached_at = 'tampered'
        WHERE result_ref = 'result-1';
      END`);
    db.close();
    const input = correctionInput(fixture.dbPath, {
      apply: true,
      ownerStopped: true,
      backupDir: join(fixture.root, "backups"),
    });
    expect(() => runSandyCorrection(input)).toThrow(/binding move|result postcondition|identity/);
    expect(readCounts(fixture.dbPath)).toEqual({ works: 1, bindings: 4, results: 309, audits: 0 });
    const verify = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(verify.query<{ attached_at: string }, [string]>(
        "SELECT attached_at FROM btcc_guided_work_results WHERE result_ref = ?",
      ).get("result-1")?.attached_at).toBe("2026-08-08T00:00:00.000Z");
    } finally {
      verify.close();
    }
  });

  test("fails closed when the canonical source Plan or checkpoint drifts", () => {
    const fixture = createFixture();
    const db = new Database(fixture.dbPath);
    db.query("UPDATE btcc_guided_work_plan_revisions SET actions_json = ? WHERE work_id = ?")
      .run(JSON.stringify([{ actionKey: "wrong-action", dependencyKeys: [], description: "drift" }]), sourceWorkId);
    db.close();
    expect(() => runSandyCorrection(correctionInput(fixture.dbPath))).toThrow(/Plan/);
  });

  test("fails closed when a Work result loses its canonical tool receipt", () => {
    const fixture = createFixture();
    const db = new Database(fixture.dbPath);
    db.query("DELETE FROM btcc_guided_tool_calls WHERE call_id = ?").run("tool-1");
    db.query("INSERT INTO btcc_guided_tool_calls VALUES (?, ?, 'completed', ?)")
      .run("tool-replacement", monitoringTurnIds[0], sha256("replacement"));
    db.close();
    expect(() => runSandyCorrection(correctionInput(fixture.dbPath))).toThrow(/completed/);
  });

  test("does not treat ownerStopped alone as authorization for canonical live apply", () => {
    expect(() => verifySandyOwnerStop({
      dbPath: "/Users/yeonwoo/.butler/app-server/butler-client.sqlite",
      sessionId,
      sourceWorkId,
      monitoringTurnIds,
      captureTurnIds,
      expected: {} as SandyCorrectionInput["expected"],
      disposition: {} as SandyCorrectionInput["disposition"],
      operatorReason: "test",
      operatorId: "test-operator",
      apply: true,
      ownerStopped: true,
    }, {
      canonicalPath: "/Users/yeonwoo/.butler/app-server/butler-client.sqlite",
      size: 1,
      mtimeMs: 1,
      pageCount: 1,
      pageSize: 4096,
      schemaVersion: 1,
      userVersion: 1,
      journalMode: "wal",
      wal: { path: "", exists: false, size: 0, mtimeMs: 0 },
      shm: { path: "", exists: false, size: 0, mtimeMs: 0 },
      sha256: "x",
    })).toThrow(/owner-manifest|known Butler owner/);
  });

  test("redacts prepare-live output to hashes and timestamps only", () => {
    const safe = redactSandyOwnerStopManifest({
      version: "sandy-owner-stop-manifest.v1",
      dbPath: "/Users/yeonwoo/.butler/app-server/butler-client.sqlite",
      generatedAt: "2026-08-08T00:00:00.000Z",
      dbSha256: "db-hash",
      wal: { exists: true, size: 10, mtimeMs: 2, sha256: "wal-hash" },
      shm: { exists: true, size: 10, mtimeMs: 2, sha256: "shm-hash" },
      ownerPids: [],
      nonce: "secret-nonce",
      backupBundleIdentity: "bundle-hash",
      sqliteSnapshotSha256: "snapshot-hash",
      manifestSha256: "manifest-hash",
    });
    expect(safe).toEqual({
      manifest_sha256: "manifest-hash",
      backup_bundle_identity: "bundle-hash",
      sqlite_snapshot_sha256: "snapshot-hash",
      generated_at: "2026-08-08T00:00:00.000Z",
      stopped_owner_count: 0,
    });
    expect(JSON.stringify(safe)).not.toContain("butler-client.sqlite");
    expect(JSON.stringify(safe)).not.toContain("secret-nonce");
  });

  test("rejects a replay when the audited after-state or operator semantics drift", () => {
    const fixture = createFixture();
    const input = correctionInput(fixture.dbPath, {
      apply: true,
      ownerStopped: true,
      backupDir: join(fixture.root, "backups"),
    });
    runSandyCorrection(input);
    const alteredReason = { ...input, operatorReason: "different semantic reason" };
    expect(() => runSandyCorrection(alteredReason)).toThrow(/source Work status mismatch|after-state/);
    const db = new Database(fixture.dbPath);
    try {
      const captureId = db.query<{ work_id: string }, [string]>(
        "SELECT work_id FROM btcc_guided_works WHERE work_id <> ?",
      ).get(sourceWorkId)?.work_id;
      if (!captureId) throw new Error("capture Work missing during replay drift test");
      db.query("UPDATE btcc_guided_works SET status = 'blocked' WHERE work_id = ?").run(captureId);
    } finally {
      db.close();
    }
    expect(() => runSandyCorrection(input)).toThrow(/after-state/);
  });
});

function correctionInput(dbPath: string, overrides: Partial<SandyCorrectionInput> = {}): SandyCorrectionInput {
  const target = { dbPath, sessionId, sourceWorkId, monitoringTurnIds, captureTurnIds };
  const observed = readSandyCorrection(target);
  return {
    ...target,
    expected: {
      sourceStatus: "open",
      bindingCount: observed.sourceBindingCount,
      resultCount: observed.sourceResultCount,
      bindingDigest: observed.bindingDigest,
      resultDigest: observed.resultDigest,
      sourceIdentitySha256: observed.identity.sha256,
      beforeSnapshotSha256: observed.beforeSnapshotSha256,
    },
    disposition: {
      summary: "Monitoring gate completed from audited evidence.",
      actionUpdates: SANDY_SOURCE_ACTION_KEYS.map((actionKey) => ({ actionKey, status: "done" as const })),
      remainingActions: [],
      nextCondition: null,
      evidenceRefs: [...monitoringTurnIds],
      evidenceSnapshot: { sampleCount: 57, source: "fixture" },
      followups: ["Review nonblocking followups later."],
    },
    operatorReason: "Copied database rehearsal",
    operatorId: "test-operator",
    ...overrides,
  };
}

function createFixture(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "sandy-correction-"));
  roots.push(root);
  const dbPath = join(root, "butler-client.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE btcc_guided_works (
      work_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope_kind TEXT NOT NULL,
      scope_ref TEXT NOT NULL, origin_turn_id TEXT NOT NULL, origin_message_id TEXT NOT NULL,
      objective TEXT NOT NULL, status TEXT NOT NULL, current_plan_revision_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE btcc_guided_work_session_heads (
      session_id TEXT PRIMARY KEY, work_id TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL
    );
    CREATE TABLE btcc_guided_turn_work_bindings (
      binding_revision_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
      work_id TEXT NOT NULL, revision INTEGER NOT NULL, is_current INTEGER NOT NULL,
      bound_at TEXT NOT NULL
    );
    CREATE TABLE btcc_guided_work_results (
      result_ref TEXT PRIMARY KEY, work_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      tool_call_id TEXT NOT NULL UNIQUE, origin_turn_id TEXT NOT NULL, attached_at TEXT NOT NULL,
      UNIQUE(work_id, sequence)
    );
    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY, original_message_id TEXT, original_message TEXT
    );
    CREATE TABLE btcc_guided_tool_calls (
      call_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      result_sha256 TEXT NOT NULL
    );
    CREATE TABLE btcc_guided_work_plan_revisions (
      plan_revision_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, revision INTEGER NOT NULL,
      objective TEXT NOT NULL, governing_refs_json TEXT NOT NULL, actions_json TEXT NOT NULL,
      checks_json TEXT NOT NULL, origin_turn_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(work_id, revision)
    );
    CREATE TABLE btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, revision INTEGER NOT NULL,
      plan_revision_id TEXT NOT NULL, stage TEXT NOT NULL, public_summary TEXT NOT NULL,
      next_step TEXT NOT NULL, action_states_json TEXT NOT NULL, result_sequence INTEGER NOT NULL,
      origin_turn_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(work_id, revision)
    );
  `);
  const now = "2026-08-08T00:00:00.000Z";
  db.query("INSERT INTO btcc_guided_works VALUES (?, ?, 'project', ?, ?, ?, ?, 'open', ?, ?, ?)")
    .run(sourceWorkId, sessionId, SANDY_SOURCE_SCOPE_REF, monitoringTurnIds[0], "message-original", SANDY_SOURCE_OBJECTIVE, SANDY_SOURCE_PLAN_REVISION_ID, now, now);
  const planActions = JSON.stringify(SANDY_SOURCE_ACTION_KEYS.map((actionKey, index) => ({
    actionKey,
    dependencyKeys: index === 0 ? [] : [SANDY_SOURCE_ACTION_KEYS[index - 1]],
    description: actionKey,
  })));
  db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)")
    .run(SANDY_SOURCE_PLAN_REVISION_ID, sourceWorkId, SANDY_SOURCE_OBJECTIVE, "[]", planActions, JSON.stringify(SANDY_SOURCE_PLAN_CHECKS), monitoringTurnIds[0], now);
  const sourceActionStates = JSON.stringify(SANDY_SOURCE_ACTION_KEYS.map((actionKey, index) => ({
    actionKey,
    status: index < 3 ? "done" : "active",
    note: index < 3 ? "Audited fixture evidence." : "Monitoring comparison is active in the source checkpoint.",
  })));
  db.query("INSERT INTO btcc_guided_work_checkpoint_revisions VALUES (?, ?, 9, ?, 'execution', ?, ?, ?, 65, ?, ?)")
    .run("guided-checkpoint-source-current", sourceWorkId, SANDY_SOURCE_PLAN_REVISION_ID,
      "Current monitoring comparison remains active before operator closeout.",
      "Complete the monitoring comparison gate.", sourceActionStates, monitoringTurnIds[0], now);
  db.query("INSERT INTO btcc_guided_work_session_heads VALUES (?, ?, ?)")
    .run(sessionId, sourceWorkId, now);
  const turnIds = [...monitoringTurnIds, ...captureTurnIds];
  turnIds.forEach((turnId, index) => {
    const originalMessage = turnId === captureTurnIds[0]
      ? SANDY_CAPTURE_OBJECTIVE
      : turnId === captureTurnIds[1]
        ? "Continue the capture safety hardening follow-up; current changes remain uncommitted."
        : `request for ${turnId}`;
    db.query("INSERT INTO btcc_turns VALUES (?, ?, ?)")
      .run(turnId, `message-${turnId}`, originalMessage);
    db.query("INSERT INTO btcc_guided_turn_work_bindings VALUES (?, ?, ?, ?, 1, 1, ?)")
      .run(`binding-${turnId}`, turnId, sessionId, sourceWorkId, new Date(Date.parse(now) + index * 1000).toISOString());
  });
  const counts = [65, 63, 63, 118];
  let sequence = 0;
  for (let turnIndex = 0; turnIndex < turnIds.length; turnIndex += 1) {
    const count = counts[turnIndex] ?? 0;
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      db.query("INSERT INTO btcc_guided_work_results VALUES (?, ?, ?, ?, ?, ?)")
        .run(`result-${sequence}`, sourceWorkId, sequence, `tool-${sequence}`, turnIds[turnIndex], now);
      db.query("INSERT INTO btcc_guided_tool_calls VALUES (?, ?, 'completed', ?)")
        .run(`tool-${sequence}`, turnIds[turnIndex], sha256(`tool result ${sequence}`));
    }
  }
  for (let index = 0; index < 8; index += 1) {
    db.query("INSERT INTO btcc_guided_tool_calls VALUES (?, ?, 'completed', ?)")
      .run(`tool-extra-${index + 1}`, monitoringTurnIds[0], sha256(`tool extra ${index + 1}`));
  }
  db.close();
  return { root, dbPath };
}

function readCounts(dbPath: string): { works: number; bindings: number; results: number; audits: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (sql: string): number => Number(db.query<{ count: number }, []>(sql).get()?.count ?? 0);
    return {
      works: count("SELECT COUNT(*) AS count FROM btcc_guided_works"),
      bindings: count("SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings"),
      results: count("SELECT COUNT(*) AS count FROM btcc_guided_work_results"),
      audits: count("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'btcc_operator_correction_audits'")
        ? count("SELECT COUNT(*) AS count FROM btcc_operator_correction_audits")
        : 0,
    };
  } finally {
    db.close();
  }
}

function rawJournalCount(db: Database): number {
  return Number(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_guided_tool_calls").get()?.count ?? 0);
}

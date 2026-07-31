import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readLedgerObservation } from
  "../support/btcc-revision-benchmark/ledger-observation.ts";

describe("BTCC revision benchmark ledger evidence", () => {
  test("reads a completed R3 guided Work lifecycle for the exact Turn", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE btcc_guided_works (
        work_id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE btcc_guided_turn_work_bindings (
        turn_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        is_current INTEGER NOT NULL
      );
      CREATE TABLE btcc_guided_work_results (work_id TEXT NOT NULL);
      CREATE TABLE btcc_guided_work_checkpoint_revisions (work_id TEXT NOT NULL);
      CREATE TABLE btcc_guided_work_review_revisions (work_id TEXT NOT NULL);
      CREATE TABLE btcc_guided_work_mutations (work_id TEXT NOT NULL);
      CREATE TABLE btcc_guided_tool_calls (
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE btcc_guided_effects (
        receipt_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO btcc_guided_works VALUES ('work-1', 'session', 'completed');
      INSERT INTO btcc_guided_turn_work_bindings VALUES ('turn-1', 'work-1', 1);
      INSERT INTO btcc_guided_work_results VALUES ('work-1');
      INSERT INTO btcc_guided_work_checkpoint_revisions VALUES ('work-1');
      INSERT INTO btcc_guided_work_review_revisions VALUES ('work-1');
      INSERT INTO btcc_guided_work_mutations VALUES ('work-1');
    `);
    try {
      expect(readLedgerObservation(db, "turn-1", "work")).toMatchObject({
        expectedRoute: "work",
        observedRoute: "work",
        source: "guided_work",
        scopeKind: "session",
        workId: "work-1",
        status: "completed",
        workRecords: 1,
        resultRecords: 1,
        checkpointRecords: 1,
        reviewRecords: 1,
        mutationRecords: 1,
        projectLedgerEffects: 0,
        closeoutObserved: true,
      });
      db.exec("UPDATE btcc_guided_works SET scope_kind = 'project'");
      expect(readLedgerObservation(db, "turn-1", "project")).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 0,
        closeoutObserved: false,
      });
      db.exec(`
        INSERT INTO btcc_guided_tool_calls
        VALUES ('turn-1', 'project_ledger_status', 'completed', '{"ok":true}');
      `);
      expect(readLedgerObservation(db, "turn-1", "project")).toMatchObject({
        projectLedgerEffects: 0,
        closeoutObserved: false,
      });
      db.exec(`
        INSERT INTO btcc_guided_effects VALUES ('receipt-1', 'applied');
        INSERT INTO btcc_guided_tool_calls VALUES (
          'turn-1',
          'project_ledger_work_complete',
          'completed',
          '{"ok":true,"effect_receipt":{"receipt_id":"receipt-1"}}'
        );
      `);
      expect(readLedgerObservation(db, "turn-1", "project")).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 1,
        closeoutObserved: true,
      });
    } finally {
      db.close();
    }
  });

  test("does not mistake an R2 session program without Work records for Work Ledger use", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE btcc_programs (
        program_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        frontier TEXT NOT NULL,
        manifest_revision INTEGER NOT NULL
      );
      CREATE TABLE btcc_work_items (
        program_id TEXT NOT NULL,
        work_id TEXT NOT NULL
      );
      CREATE TABLE btcc_tasks (
        program_id TEXT NOT NULL,
        result_ref TEXT
      );
      CREATE TABLE btcc_checkpoints (turn_id TEXT NOT NULL);
      CREATE TABLE btcc_ledger_mutations (program_id TEXT NOT NULL);
      INSERT INTO btcc_turns VALUES ('turn-1', 'session-1');
      INSERT INTO btcc_programs
        VALUES ('program-1', 'session-1', 'session', 'unplanned', 1);
      INSERT INTO btcc_ledger_mutations VALUES ('program-1');
    `);
    try {
      expect(readLedgerObservation(db, "turn-1", "work")).toMatchObject({
        expectedRoute: "work",
        observedRoute: "none",
        source: "legacy_program",
        workRecords: 0,
        taskRecords: 0,
        resultRecords: 0,
        mutationRecords: 1,
        closeoutObserved: false,
      });
    } finally {
      db.close();
    }
  });
});

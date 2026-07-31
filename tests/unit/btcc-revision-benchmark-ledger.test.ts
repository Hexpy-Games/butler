import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLedgerObservation,
  resolveBenchmarkLedgerProjectId,
} from
  "../support/btcc-revision-benchmark/ledger-observation.ts";

describe("BTCC revision benchmark ledger evidence", () => {
  test("uses each frozen revision's actual canonical project identity", () => {
    const db = new Database(":memory:");
    const dataRoot = mkdtempSync(join(tmpdir(), "btcc-benchmark-project-id-"));
    const workspaceRoot = join(dataRoot, "workspace");
    const r2LedgerRoot = join(
      dataRoot,
      "project-ledger",
      "projects",
      "butler-benchmark-site",
    );
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(r2LedgerRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, "project.json"),
      JSON.stringify({ id: "uninitialized-workspace-id" }),
    );
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "butler-benchmark-site" }),
    );
    writeFileSync(
      join(r2LedgerRoot, "project.json"),
      JSON.stringify({ id: "butler-benchmark-site" }),
    );
    writeFileSync(join(r2LedgerRoot, "ledger.jsonl"), "");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        workspace_label TEXT NOT NULL,
        safe_path_label TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO projects VALUES (
        'project-app-id', 'Benchmark', 'workspace', 'workspace', 0
      );
    `);
    try {
      expect(resolveBenchmarkLedgerProjectId({
        appProjectId: "project-app-id",
        dataRoot,
        db,
        revision: "r2",
        workspaceRoot,
      })).toBe("butler-benchmark-site");
      expect(resolveBenchmarkLedgerProjectId({
        appProjectId: "project-app-id",
        dataRoot,
        db,
        revision: "r3",
        workspaceRoot,
      })).toBe("project-app-id");
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("reads a completed R3 guided Work lifecycle for the exact Turn", () => {
    const db = new Database(":memory:");
    const dataRoot = mkdtempSync(join(tmpdir(), "btcc-benchmark-ledger-"));
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
        work_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        sanitized_target TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO btcc_guided_works VALUES ('work-1', 'session', 'completed');
      INSERT INTO btcc_guided_turn_work_bindings VALUES ('turn-1', 'work-1', 1);
      INSERT INTO btcc_guided_work_results VALUES ('work-1');
      INSERT INTO btcc_guided_work_review_revisions VALUES ('work-1');
      INSERT INTO btcc_guided_work_review_revisions VALUES ('work-1');
      INSERT INTO btcc_guided_work_mutations VALUES ('work-1');
    `);
    try {
      expect(readLedgerObservation(db, "turn-1", "work", dataRoot)).toMatchObject({
        expectedRoute: "work",
        observedRoute: "work",
        source: "guided_work",
        scopeKind: "session",
        workId: "work-1",
        status: "completed",
        workRecords: 1,
        resultRecords: 1,
        checkpointRecords: 0,
        reviewRecords: 2,
        mutationRecords: 1,
        projectLedgerEffects: 0,
        closeoutObserved: true,
      });
      db.exec(`
        DELETE FROM btcc_guided_work_review_revisions
        WHERE rowid IN (
          SELECT rowid FROM btcc_guided_work_review_revisions LIMIT 1
        )
      `);
      expect(readLedgerObservation(db, "turn-1", "work", dataRoot)).toMatchObject({
        status: "completed",
        resultRecords: 1,
        reviewRecords: 1,
        closeoutObserved: false,
      });
      db.exec("INSERT INTO btcc_guided_work_review_revisions VALUES ('work-1')");
      db.exec("UPDATE btcc_guided_works SET scope_kind = 'project'");
      const workDir = join(
        dataRoot,
        "project-ledger",
        "projects",
        "fixture",
        "work",
        "W-PROJECT",
      );
      mkdirSync(workDir, { recursive: true });
      const workPath = join(workDir, "work.md");
      writeProjectWork(workPath, "in_progress");
      expect(readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      )).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 0,
        closeoutObserved: false,
      });
      db.exec(`
        INSERT INTO btcc_guided_tool_calls
        VALUES ('turn-1', 'project_ledger_status', 'completed', '{"ok":true}');
      `);
      expect(readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      )).toMatchObject({
        projectLedgerEffects: 0,
        closeoutObserved: false,
      });
      db.exec(`
        INSERT INTO btcc_guided_effects VALUES (
          'receipt-1', 'work-1', 'project_ledger_create',
          'project-ledger:work:W-PROJECT', 'applied'
        );
        INSERT INTO btcc_guided_tool_calls VALUES (
          'turn-1',
          'project_ledger_create',
          'completed',
          '{"ok":true,"effect_receipt":{"receipt_id":"receipt-1"}}'
        );
      `);
      expect(readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      )).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 1,
        closeoutObserved: false,
      });
      db.exec(`
        INSERT INTO btcc_guided_effects VALUES (
          'receipt-2', 'work-1', 'project_ledger_work_complete',
          'project-ledger:work:W-PROJECT', 'applied'
        );
        INSERT INTO btcc_guided_tool_calls VALUES (
          'turn-1',
          'project_ledger_work_complete',
          'completed',
          '{"ok":true,"effect_receipt":{"receipt_id":"receipt-2"}}'
        );
      `);
      expect(readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      )).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 2,
        closeoutObserved: false,
      });
      const otherProjectWorkDir = join(
        dataRoot,
        "project-ledger",
        "projects",
        "other-project",
        "work",
        "W-PROJECT",
      );
      mkdirSync(otherProjectWorkDir, { recursive: true });
      writeProjectWork(join(otherProjectWorkDir, "work.md"), "done");
      const unrelatedWorkDir = join(
        dataRoot,
        "project-ledger",
        "projects",
        "fixture",
        "work",
        "W-UNRELATED",
      );
      mkdirSync(unrelatedWorkDir, { recursive: true });
      const unrelatedWorkPath = join(unrelatedWorkDir, "work.md");
      writeProjectWork(unrelatedWorkPath, "done", "W-UNRELATED");
      expect(readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      )).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 2,
        closeoutObserved: false,
      });
      writeProjectWork(workPath, "done");
      const completed = readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      );
      expect(completed).toMatchObject({
        observedRoute: "project",
        projectLedgerEffects: 2,
        closeoutObserved: true,
      });
      expect(completed.evidenceRefs).toContain(
        "project-ledger/projects/fixture/work/W-PROJECT/work.md",
      );
      expect(completed.evidenceRefs).not.toContain(
        "project-ledger/projects/fixture/work/W-UNRELATED/work.md",
      );
      expect(completed.evidenceRefs).not.toContain(
        "project-ledger/projects/other-project/work/W-PROJECT/work.md",
      );
      expect(
        readLedgerObservation(db, "turn-1", "project", dataRoot).closeoutObserved,
      ).toBe(false);
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
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
      CREATE TABLE btcc_ledger_mutations (
        program_id TEXT NOT NULL,
        turn_id TEXT NOT NULL
      );
      INSERT INTO btcc_turns VALUES ('turn-1', 'session-1');
      INSERT INTO btcc_programs
        VALUES ('program-1', 'session-1', 'session', 'unplanned', 1);
      INSERT INTO btcc_ledger_mutations VALUES ('program-1', 'turn-1');
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

  test("requires canonical Project Ledger Work done for R2 project closeout", () => {
    const db = new Database(":memory:");
    const dataRoot = mkdtempSync(join(tmpdir(), "btcc-benchmark-r2-project-"));
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
      CREATE TABLE btcc_ledger_mutations (
        program_id TEXT NOT NULL,
        turn_id TEXT NOT NULL
      );
      INSERT INTO btcc_turns VALUES ('turn-1', 'session-1');
      INSERT INTO btcc_programs
        VALUES ('program-1', 'session-1', 'project', 'reported', 1);
      INSERT INTO btcc_work_items VALUES ('program-1', 'W-PROJECT');
      INSERT INTO btcc_tasks VALUES ('program-1', 'result-1');
      INSERT INTO btcc_ledger_mutations VALUES ('program-1', 'turn-1');
      INSERT INTO btcc_programs
        VALUES ('program-unrelated', 'session-1', 'project', 'reported', 99);
      INSERT INTO btcc_work_items VALUES ('program-unrelated', 'W-UNRELATED');
      INSERT INTO btcc_tasks VALUES ('program-unrelated', 'result-unrelated');
      INSERT INTO btcc_ledger_mutations
        VALUES ('program-unrelated', 'turn-unrelated');
    `);
    const workDir = join(
      dataRoot,
      "project-ledger",
      "projects",
      "fixture",
      "work",
      "W-PROJECT",
    );
    mkdirSync(workDir, { recursive: true });
    const workPath = join(workDir, "work.md");
    const unrelatedWorkDir = join(
      dataRoot,
      "project-ledger",
      "projects",
      "fixture",
      "work",
      "W-UNRELATED",
    );
    mkdirSync(unrelatedWorkDir, { recursive: true });
    const unrelatedWorkPath = join(unrelatedWorkDir, "work.md");
    const otherProjectWorkDir = join(
      dataRoot,
      "project-ledger",
      "projects",
      "other-project",
      "work",
      "W-PROJECT",
    );
    mkdirSync(otherProjectWorkDir, { recursive: true });
    const otherProjectWorkPath = join(otherProjectWorkDir, "work.md");
    try {
      writeProjectWork(workPath, "in_progress");
      writeProjectWork(unrelatedWorkPath, "done", "W-UNRELATED");
      writeProjectWork(otherProjectWorkPath, "done");
      expect(readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      )).toMatchObject({
        expectedRoute: "project",
        observedRoute: "project",
        source: "legacy_program",
        status: "reported",
        workRecords: 1,
        resultRecords: 1,
        mutationRecords: 1,
        closeoutObserved: false,
      });

      writeProjectWork(workPath, "done");
      const completed = readLedgerObservation(
        db,
        "turn-1",
        "project",
        dataRoot,
        "fixture",
      );
      expect(completed).toMatchObject({
        expectedRoute: "project",
        observedRoute: "project",
        source: "legacy_program",
        closeoutObserved: true,
      });
      expect(completed.evidenceRefs).toContain(
        "project-ledger/projects/fixture/work/W-PROJECT/work.md",
      );
      expect(completed.evidenceRefs).not.toContain(
        "project-ledger/projects/fixture/work/W-UNRELATED/work.md",
      );
      expect(completed.evidenceRefs).not.toContain(
        "project-ledger/projects/other-project/work/W-PROJECT/work.md",
      );
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

function writeProjectWork(
  path: string,
  status: string,
  id = "W-PROJECT",
): void {
  writeFileSync(path, [
    "---",
    `id: "${id}"`,
    `status: "${status}"`,
    "---",
    "",
  ].join("\n"));
}

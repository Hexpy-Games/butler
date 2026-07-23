import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const HARNESS = resolve(
  import.meta.dir,
  "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
);

test("ends a managed deferral truthfully and continues it through a fresh Turn", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-continuation-"));
  try {
    const deferred = await runHarness(dataRoot, {
      turn: "turn-deferred-source",
      message: "운영 가이드를 준비하되 승인 전에 멈춰줘.",
      scenario: "managed-deferral",
    });
    expect(deferred.initial.kind).toBe("delivered");
    expect(deferred.initial.content).toContain("사용자 승인이 필요");

    const continued = await runHarness(dataRoot, {
      turn: "turn-deferred-continuation",
      message: "승인할게. 보존된 작업을 이어서 끝내줘.",
      scenario: "managed-continuation",
    });
    expect(continued.initial.kind).toBe("delivered");
    expect(continued.initial.content).toContain("완성");
    expect(continued.initial.content).toContain("변경:");
    expect(continued.initial.content).toContain("검증:");

    const db = openDatabase(dataRoot);
    try {
      const turns = db.query<{
        turn_id: string;
        semantic_state: string;
        final_disposition: string;
      }, []>(`
        SELECT turn_id, semantic_state, final_disposition
        FROM btcc_turns ORDER BY rowid
      `).all();
      const program = db.query<{
        frontier: string;
        active_deferral_ref: string | null;
      }, []>(`
        SELECT frontier, active_deferral_ref FROM btcc_programs
      `).get();
      const candidates = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_programs
      `).get();
      const binding = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records
        WHERE kind = 'authority_revision' ORDER BY rowid DESC LIMIT 1
      `).get();

      expect(turns).toEqual([
        {
          turn_id: "turn-deferred-source",
          semantic_state: "delivered",
          final_disposition: "deferred",
        },
        {
          turn_id: "turn-deferred-continuation",
          semantic_state: "delivered",
          final_disposition: "completed",
        },
      ]);
      expect(candidates?.count).toBe(1);
      expect(program).toEqual({ frontier: "closed", active_deferral_ref: null });
      expect(JSON.parse(binding!.content_json).managedBinding.source).toBe("deferred_goal");
      expect(learningOutboxCount(db)).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

test("closes a pre-commit promotion deferral without mutating the target", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-promotion-deferral-"));
  try {
    const result = await runHarness(dataRoot, {
      turn: "turn-promotion-deferred",
      message: "격리 구현을 검토하고 승인 전 조건이 없으면 보존해줘.",
      scenario: "managed-promotion-deferral",
    });
    expect(result.initial.kind).toBe("delivered");
    expect(result.initial.content).toContain("사용자 승인이 필요");

    const db = openDatabase(dataRoot);
    try {
      const program = db.query<{
        frontier: string;
        active_deferral_ref: string | null;
        promotion_deferral_ref: string | null;
      }, []>(`
        SELECT frontier, active_deferral_ref, promotion_deferral_ref
        FROM btcc_programs
      `).get();
      const promotionTask = db.query<{ status: string }, []>(`
        SELECT status FROM btcc_tasks WHERE task_kind = 'repository_promotion'
      `).get();
      const promotionCalls = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_phase_operation_result_links
        WHERE request_json LIKE '%repository_promotion%'
      `).get();
      const dossier = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records WHERE kind = 'final_dossier'
      `).get();

      expect(program?.frontier).toBe("closed");
      expect(program?.active_deferral_ref).toBeTruthy();
      expect(program?.promotion_deferral_ref).toBeTruthy();
      expect(promotionTask?.status).toBe("promotion_deferred");
      expect(promotionCalls?.count).toBe(0);
      const finalDossier = JSON.parse(dossier!.content_json);
      expect(finalDossier.promotionClosure).toBe("deferred");
      expect(finalDossier.userReport.limitations).toContain(
        "다음 단계에는 사용자의 명시적 승인이 필요하다",
      );
      expect(learningOutboxCount(db)).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

test("returns a whole-goal Consolidation finding through the reviewed feedback loop", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-consolidation-repair-"));
  try {
    const result = await runHarness(dataRoot, {
      turn: "turn-consolidation-repair",
      message: "개별 항목뿐 아니라 전체 운영 가이드의 완성도까지 검토해줘.",
      scenario: "managed-consolidation-repair",
    });
    expect(result.initial.kind).toBe("delivered");
    expect(result.phases.filter((phase: string) => phase === "consolidation")).toHaveLength(2);
    expect(result.phases).toContain("feedback_conception");
    expect(result.phases).toContain("feedback_planning_review");

    const db = openDatabase(dataRoot);
    try {
      const repair = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_records WHERE kind = 'consolidation_repair'
      `).get();
      const assessment = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records
        WHERE kind = 'consolidation_assessment' ORDER BY rowid LIMIT 1
      `).get();
      const program = db.query<{ frontier: string }, []>(`
        SELECT frontier FROM btcc_programs
      `).get();
      expect(repair?.count).toBe(1);
      const assessed = JSON.parse(assessment!.content_json);
      expect(assessed.goalFieldVerdicts).toHaveLength(2);
      expect(assessed.goalFieldVerdicts[1].verdict).toBe("not_fulfilled");
      expect(assessed.taskCompatibility.reviewedTaskRefs).toEqual(assessed.taskReviewRefs);
      expect(program?.frontier).toBe("closed");
      expect(learningOutboxCount(db)).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

async function runHarness(
  dataRoot: string,
  input: { turn: string; message: string; scenario: string },
) {
  const child = Bun.spawn([
    process.execPath,
    "run",
    HARNESS,
    "--data", dataRoot,
    "--turn", input.turn,
    "--session", "session-finalization-continuation",
    "--message", input.message,
    "--provider", "openai",
    "--model", "gpt-5.6-sol",
    "--effort", "low",
    "--scenario", input.scenario,
    "--replay",
  ], { cwd: ROOT, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout.trim());
}

function openDatabase(dataRoot: string): Database {
  return new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
    readonly: true,
  });
}

function learningOutboxCount(db: Database): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_learning_candidate_outbox
  `).get()!.count;
}

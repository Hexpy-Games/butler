import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("BTCC managed executable ingress", () => {
  test.each([
    ["managed-pass", 9, 1],
    ["managed-review-repair", 14, 2],
  ] as const)("completes %s through the same Turn entry", async (
    scenario,
    expectedModelCalls,
    expectedAttempts,
  ) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `butler-btcc-${scenario}-`));
    temporaryRoots.push(dataRoot);
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );
    const turnId = `turn-${scenario}`;

    const child = Bun.spawn([
      process.execPath,
      "run",
      harness,
      "--data", dataRoot,
      "--turn", turnId,
      "--session", `session-${scenario}`,
      "--message", "고객 응대 원칙을 조사해서 짧은 운영 가이드를 작성해줘.",
      "--provider", "harness",
      "--model", "managed-v1",
      "--effort", "medium",
      "--profile-ref", "profile:concise",
      "--hot-cache-ref", "cache:preserve-original-intent",
      "--scenario", scenario,
      "--replay",
    ], {
      cwd: resolve(import.meta.dir, "../.."),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout.trim()) as {
      initial: { kind: string; messageId: string; content: string };
      replay: { kind: string; messageId: string; content: string };
      modelCalls: number;
      phases: string[];
    };
    expect(result.initial.kind).toBe("delivered");
    expect(result.replay).toEqual(result.initial);
    expect(result.modelCalls).toBe(expectedModelCalls);
    const commonStart = [
      "conception_opening", "conception_deliberation", "contract_review",
      "planning", "planning_review", "task_execution", "task_review",
    ];
    expect(result.phases).toEqual(scenario === "managed-pass"
      ? [...commonStart, "consolidation", "reporting"]
      : [
          ...commonStart,
          "feedback_conception", "feedback_planning", "feedback_planning_review",
          "task_execution", "task_review", "consolidation", "reporting",
        ]);
    if (scenario === "managed-review-repair") {
      expect(result.phases).toContain("feedback_conception");
      expect(result.phases).toContain("feedback_planning");
      expect(result.phases).toContain("feedback_planning_review");
    }

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      const turn = db.query<{
        semantic_state: string;
        route: string;
        goal_contract_ref: string;
        final_dossier_ref: string;
      }, [string]>(`
        SELECT semantic_state, route, goal_contract_ref, final_dossier_ref
        FROM btcc_turns WHERE turn_id = ?
      `).get(turnId);
      const program = db.query<{
        goal_contract_ref: string;
        frontier: string;
      }, []>("SELECT goal_contract_ref, frontier FROM btcc_programs").get();
      const task = db.query<{ status: string }, []>(
        "SELECT status FROM btcc_tasks",
      ).get();
      const attempts = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_attempts",
      ).get();
      const openingProjection = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_opening_projections",
      ).get();
      const reviewRecords = db.query<{ content_json: string }, []>(
        "SELECT content_json FROM btcc_records WHERE kind = 'task_review' ORDER BY rowid",
      ).all();
      const dossierRecord = db.query<{ content_json: string }, []>(
        "SELECT content_json FROM btcc_records WHERE kind = 'final_dossier'",
      ).get();
      const attemptRows = db.query<{
        attempt_id: string;
        previous_attempt_id: string | null;
        correction_plan_ref: string | null;
      }, []>(`
        SELECT attempt_id, previous_attempt_id, correction_plan_ref
        FROM btcc_attempts ORDER BY rowid
      `).all();

      expect(turn?.semantic_state).toBe("delivered");
      expect(turn?.route).toBe("managed");
      expect(turn?.goal_contract_ref).toBe(program?.goal_contract_ref);
      expect(turn?.final_dossier_ref).toBeTruthy();
      expect(program?.frontier).toBe("closed");
      expect(task?.status).toBe("accepted");
      expect(attempts?.count).toBe(expectedAttempts);
      expect(openingProjection?.count).toBe(1);
      for (const record of reviewRecords) {
        expect(JSON.parse(record.content_json).goalContractRef.id).toBe(turn!.goal_contract_ref);
      }
      expect(JSON.parse(dossierRecord!.content_json).originalGoalContractRef.id)
        .toBe(turn!.goal_contract_ref);
      if (scenario === "managed-review-repair") {
        expect(attemptRows[1]?.previous_attempt_id).toBe(attemptRows[0]?.attempt_id);
        expect(attemptRows[1]?.correction_plan_ref).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});

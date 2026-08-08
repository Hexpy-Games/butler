import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableWorkService,
  type DurableWorkService,
  type DurableWorkStore,
  type ReplaceWorkPlanInput,
  type WorkTurnScope,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  SqliteGuidedToolJournal,
  SqliteGuidedWorkStore,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { backfillTurnToolResults } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-work-runtime.ts";
import { coordinateSharedSqliteWriter } from
  "../../packages/butler-agent/src/foundation/sqlite-writer-coordination.ts";

test("first Plan opens scoped Work without making Direct or Assisted Turns pay for it", async () => {
  const fixture = durableWorkFixture();
  try {
    const direct = fixture.turn("turn-direct", "session-1", "간단히 답해 주세요.");
    expect(await fixture.service.loadContext(direct)).toBeNull();
    expect(fixture.count("btcc_guided_works")).toBe(0);

    const opened = await fixture.service.replacePlan(planInput(direct, "plan-call-1"));
    expect(opened).toMatchObject({
      sessionId: "session-1",
      scope: { kind: "session", sessionId: "session-1" },
      status: "open",
      objective: "요청한 보고서를 작성한다",
      currentStage: "planning",
      allowedNextStages: ["review"],
      actionProgress: [{ actionKey: "write-report", status: "pending" }],
      origin: { turnId: "turn-direct", messageId: "message-turn-direct" },
      currentPlan: { revision: 1 },
    });
    const context = await fixture.service.loadContext(direct);
    expect(context?.originalRequest.content).toBe("간단히 답해 주세요.");
    expect(context?.resultFacts).toEqual([]);
    expect(fixture.columns("btcc_guided_works")).not.toContain("original_message");

    const replay = await fixture.service.replacePlan(planInput(direct, "plan-call-1"));
    expect(replay.currentPlan?.planRevisionId).toBe(opened.currentPlan?.planRevisionId);
    expect(fixture.count("btcc_guided_work_plan_revisions")).toBe(1);
    await expect(fixture.service.replacePlan({
      ...planInput(direct, "plan-call-1"),
      objective: "같은 mutation identity로 다른 계획",
    })).rejects.toThrow("mutation identity conflict");
  } finally {
    fixture.close();
  }
});

test("legacy replace_plan translates relation exactly once before writing its Plan", async () => {
  const fixture = durableWorkFixture();
  try {
    const origin = fixture.turn(
      "turn-legacy-relation-origin",
      "session-legacy-relation",
      "보고서를 준비해 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(origin, "legacy-opening-plan"),
    );
    expect(fixture.db.query<{ operation: string; work_id: string }, []>(`
      SELECT operation, work_id FROM btcc_guided_work_relation_commands
      ORDER BY rowid
    `).all()).toEqual([{
      operation: "start_work",
      work_id: opened.workId,
    }]);

    const continuation = fixture.turn(
      "turn-legacy-relation-continue",
      "session-legacy-relation",
      "이어서 검증해 주세요.",
    );
    const revised = await fixture.service.replacePlan({
      ...planInput(continuation, "legacy-continuation-plan"),
      objective: "보고서를 검증해 마무리한다",
    });
    expect(revised.workId).toBe(opened.workId);
    expect(await fixture.service.boundWorkForTurn(continuation.turnId))
      .toMatchObject({ workId: opened.workId });
    expect(fixture.db.query<{ operation: string; work_id: string }, []>(`
      SELECT operation, work_id FROM btcc_guided_work_relation_commands
      ORDER BY rowid
    `).all()).toEqual([
      { operation: "start_work", work_id: opened.workId },
      { operation: "continue_work", work_id: opened.workId },
    ]);

    const replay = await fixture.service.replacePlan({
      ...planInput(continuation, "legacy-continuation-plan"),
      objective: "보고서를 검증해 마무리한다",
    });
    expect(replay.currentPlan?.planRevisionId).toBe(revised.currentPlan?.planRevisionId);
    expect(fixture.count("btcc_guided_work_relation_commands")).toBe(2);
  } finally {
    fixture.close();
  }
});

test("explicit relation commands replay idempotently after SQLite restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-explicit-relation-"));
  const dbPath = join(root, "butler.sqlite");
  let db: Database | null = new Database(dbPath);
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const first = createDurableWorkService(new SqliteGuidedWorkStore(db));
    const startScope = insertGuidedTurn(
      db,
      "turn-explicit-start",
      "session-explicit-relation",
      "새 보고서를 준비해 주세요.",
    );
    const started = await first.startWork({
      ...startScope,
      mutationCallId: "explicit-start-call",
      objective: "새 보고서를 준비한다",
    });
    const replayedInProcess = await first.startWork({
      ...startScope,
      mutationCallId: "explicit-start-call",
      objective: "새 보고서를 준비한다",
    });
    expect(replayedInProcess.workId).toBe(started.workId);
    await expect(first.startWork({
      ...startScope,
      mutationCallId: "explicit-start-call",
      objective: "다른 목표",
    })).rejects.toThrow("relation identity conflict");
    db.close();
    db = null;

    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const resumed = createDurableWorkService(new SqliteGuidedWorkStore(db));
    const replayedAfterRestart = await resumed.startWork({
      ...startScope,
      mutationCallId: "explicit-start-call",
      objective: "새 보고서를 준비한다",
    });
    expect(replayedAfterRestart.workId).toBe(started.workId);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_works
    `).get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings
      WHERE is_current = 1
    `).get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_work_relation_commands
    `).get()?.count).toBe(1);

    const continueScope = insertGuidedTurn(
      db,
      "turn-explicit-continue",
      "session-explicit-relation",
      "이어서 검토해 주세요.",
    );
    const continued = await resumed.continueWork({
      ...continueScope,
      mutationCallId: "explicit-continue-call",
      workId: started.workId,
    });
    const continuedReplay = await resumed.continueWork({
      ...continueScope,
      mutationCallId: "explicit-continue-call",
      workId: started.workId,
    });
    expect(continued.workId).toBe(started.workId);
    expect(continuedReplay.workId).toBe(started.workId);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_work_relation_commands
    `).get()?.count).toBe(2);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit relation makes legacy startNew unable to switch Work", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-explicit-no-switch",
      "session-explicit-no-switch",
      "먼저 바인딩한 Work를 이어서 진행해 주세요.",
    );
    const started = await fixture.service.startWork({
      ...scope,
      mutationCallId: "explicit-no-switch-start",
      objective: "기존 Work를 진행한다",
    });
    expect(await fixture.service.boundWorkForTurn(scope.turnId))
      .toMatchObject({ workId: started.workId, status: "open" });

    await expect(fixture.service.replacePlan({
      ...planInput(scope, "explicit-no-switch-legacy-plan"),
      startNew: true,
    })).rejects.toThrow("relation is already selected");

    expect(fixture.count("btcc_guided_works")).toBe(1);
    expect(fixture.count("btcc_guided_work_session_heads")).toBe(1);
    expect(fixture.count("btcc_guided_work_relation_commands")).toBe(1);
    expect(fixture.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_guided_works WHERE work_id = ?
    `).get(started.workId)?.status).toBe("open");
    expect(fixture.db.query<{ work_id: string }, [string]>(`
      SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?
    `).get(scope.sessionId)?.work_id).toBe(started.workId);
    expect(await fixture.service.boundWorkForTurn(scope.turnId))
      .toMatchObject({ workId: started.workId, status: "open" });
  } finally {
    fixture.close();
  }
});

test("start_work atomically backfills completed reads in journal order onto only the new Work", async () => {
  const fixture = durableWorkFixture();
  try {
    const candidateTurn = fixture.turn(
      "turn-atomic-backfill-candidate",
      "session-atomic-backfill",
      "기존 후보 Work를 열어 주세요.",
    );
    const candidate = await fixture.service.replacePlan(
      planInput(candidateTurn, "atomic-backfill-candidate-plan"),
    );
    const scope = fixture.turn(
      "turn-atomic-backfill-start",
      "session-atomic-backfill",
      "두 결과를 새 Work에 연결해 주세요.",
    );
    fixture.tool(scope.turnId, "z-read-first", "read_file", {
      content: "first",
    });
    fixture.tool(scope.turnId, "a-read-second", "read_file", {
      content: "second",
    });
    fixture.db.query(`
      UPDATE btcc_guided_tool_calls
      SET started_at = '2026-08-08T00:00:00.000Z'
      WHERE turn_id = ?
    `).run(scope.turnId);

    const started = await fixture.service.startWork({
      ...scope,
      mutationCallId: "atomic-backfill-start",
      objective: "두 결과를 검증한다",
      backfillToolCallIds: ["z-read-first", "a-read-second"],
    });

    expect(started.workId).not.toBe(candidate.workId);
    expect(started.resultRefs.map((result) => result.toolCallId)).toEqual([
      "z-read-first",
      "a-read-second",
    ]);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))?.workId)
      .toBe(started.workId);
    expect((await fixture.service.boundWorkForTurn(candidateTurn.turnId))?.status)
      .toBe("abandoned");
    expect((await fixture.service.loadContext(candidateTurn))?.work.resultRefs)
      .toEqual([]);
    expect(fixture.count("btcc_guided_work_results")).toBe(2);
  } finally {
    fixture.close();
  }
});

test("relation backfill failure rolls back Work, binding, receipt, and prior attachments", async () => {
  const fixture = durableWorkFixture();
  try {
    const candidateTurn = fixture.turn(
      "turn-atomic-failure-candidate",
      "session-atomic-failure",
      "기존 후보 Work를 열어 주세요.",
    );
    const candidate = await fixture.service.replacePlan(
      planInput(candidateTurn, "atomic-failure-candidate-plan"),
    );
    const scope = fixture.turn(
      "turn-atomic-failure-start",
      "session-atomic-failure",
      "결과 연결 중 오류를 검증해 주세요.",
    );
    fixture.tool(scope.turnId, "atomic-failure-read-1", "read_file", {
      content: "first",
    });
    fixture.tool(scope.turnId, "atomic-failure-read-2", "read_file", {
      content: "second",
    });
    fixture.db.exec(`
      CREATE TRIGGER atomic_backfill_failure
      BEFORE INSERT ON btcc_guided_work_results
      WHEN NEW.tool_call_id = 'atomic-failure-read-2'
      BEGIN
        SELECT RAISE(ABORT, 'injected backfill failure');
      END;
    `);

    await expect(fixture.service.startWork({
      ...scope,
      mutationCallId: "atomic-failure-start",
      objective: "실패 시 아무 관계도 남기지 않는다",
      backfillToolCallIds: [
        "atomic-failure-read-1",
        "atomic-failure-read-2",
      ],
    })).rejects.toThrow("injected backfill failure");

    expect(fixture.count("btcc_guided_works")).toBe(1);
    expect(fixture.count("btcc_guided_turn_work_bindings")).toBe(1);
    expect(fixture.count("btcc_guided_work_results")).toBe(0);
    expect(fixture.count("btcc_guided_work_relation_commands")).toBe(1);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))).toBeNull();
    expect((await fixture.service.boundWorkForTurn(candidateTurn.turnId))?.workId)
      .toBe(candidate.workId);
    expect((await fixture.service.boundWorkForTurn(candidateTurn.turnId))?.status)
      .toBe("open");
    expect(fixture.db.query<{ work_id: string }, [string]>(`
      SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?
    `).get(scope.sessionId)?.work_id).toBe(candidate.workId);
  } finally {
    fixture.close();
  }
});

test("legacy replace_plan relation translation backfills atomically", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-legacy-atomic-backfill",
      "session-legacy-atomic-backfill",
      "계획을 열며 두 결과를 연결해 주세요.",
    );
    fixture.tool(scope.turnId, "legacy-atomic-read-1", "read_file", {
      content: "first",
    });
    fixture.tool(scope.turnId, "legacy-atomic-read-2", "read_file", {
      content: "second",
    });
    fixture.db.exec("CREATE TRIGGER legacy_atomic_backfill_failure " +
      "BEFORE INSERT ON btcc_guided_work_results " +
      "WHEN NEW.tool_call_id = 'legacy-atomic-read-2' " +
      "BEGIN SELECT RAISE(ABORT, 'injected legacy backfill failure'); END;");

    await expect(fixture.service.replacePlan({
      ...planInput(scope, "legacy-atomic-plan"),
      startNew: true,
      backfillToolCallIds: [
        "legacy-atomic-read-1",
        "legacy-atomic-read-2",
      ],
    })).rejects.toThrow("injected legacy backfill failure");

    expect(fixture.count("btcc_guided_works")).toBe(0);
    expect(fixture.count("btcc_guided_work_session_heads")).toBe(0);
    expect(fixture.count("btcc_guided_turn_work_bindings")).toBe(0);
    expect(fixture.count("btcc_guided_work_relation_commands")).toBe(0);
    expect(fixture.count("btcc_guided_work_plan_revisions")).toBe(0);
    expect(fixture.count("btcc_guided_work_results")).toBe(0);
  } finally {
    fixture.close();
  }
});

test("start_work rejects cancelled or fenced Turns without relation rows", async () => {
  for (const state of ["cancelled", "fenced"] as const) {
    const fixture = durableWorkFixture();
    try {
      const scope = fixture.turn(
        `turn-start-${state}`,
        `session-start-${state}`,
        "중단된 Turn에서는 Work를 열지 마세요.",
      );
      if (state === "cancelled") {
        fixture.db.query(`
          UPDATE btcc_turns SET semantic_state = 'cancelled',
            execution_fence = execution_fence + 1,
            final_disposition = 'cancelled'
          WHERE turn_id = ?
        `).run(scope.turnId);
      } else {
        fixture.db.query(`
          UPDATE btcc_turns SET execution_fence = execution_fence + 1
          WHERE turn_id = ?
        `).run(scope.turnId);
      }

      await expect(fixture.service.startWork({
        ...scope,
        mutationCallId: `start-${state}-relation`,
        objective: "중단된 Turn에서 시작하지 않는다",
      })).rejects.toThrow("stopped or fenced");

      expect(fixture.count("btcc_guided_works")).toBe(0);
      expect(fixture.count("btcc_guided_work_session_heads")).toBe(0);
      expect(fixture.count("btcc_guided_turn_work_bindings")).toBe(0);
      expect(fixture.count("btcc_guided_work_relation_commands")).toBe(0);
    } finally {
      fixture.close();
    }
  }
});

test("continue_work rejects cancelled or fenced Turns without binding or receipt", async () => {
  for (const state of ["cancelled", "fenced"] as const) {
    const fixture = durableWorkFixture();
    try {
      const origin = fixture.turn(
        `turn-continue-origin-${state}`,
        `session-continue-${state}`,
        "먼저 Work를 열어 주세요.",
      );
      const opened = await fixture.service.replacePlan(
        planInput(origin, `continue-origin-${state}`),
      );
      const continuation = fixture.turn(
        `turn-continue-${state}`,
        `session-continue-${state}`,
        "중단된 Turn에서는 이어 붙이지 마세요.",
      );
      if (state === "cancelled") {
        fixture.db.query(`
          UPDATE btcc_turns SET semantic_state = 'cancelled',
            execution_fence = execution_fence + 1,
            final_disposition = 'cancelled'
          WHERE turn_id = ?
        `).run(continuation.turnId);
      } else {
        fixture.db.query(`
          UPDATE btcc_turns SET execution_fence = execution_fence + 1
          WHERE turn_id = ?
        `).run(continuation.turnId);
      }

      await expect(fixture.service.continueWork({
        ...continuation,
        mutationCallId: `continue-${state}-relation`,
        workId: opened.workId,
      })).rejects.toThrow("stopped or fenced");

      expect(fixture.count("btcc_guided_works")).toBe(1);
      expect(fixture.count("btcc_guided_turn_work_bindings")).toBe(1);
      expect(fixture.count("btcc_guided_work_relation_commands")).toBe(1);
      expect(await fixture.service.boundWorkForTurn(continuation.turnId)).toBeNull();
      expect(await fixture.service.boundWorkForTurn(origin.turnId))
        .toMatchObject({ workId: opened.workId, status: "open" });
      expect(fixture.db.query<{ work_id: string }, [string]>(`
        SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?
      `).get(continuation.sessionId)?.work_id).toBe(opened.workId);
    } finally {
      fixture.close();
    }
  }
});

test("Stop fences all bound Work result and progress writes without mutation", async () => {
  for (const state of ["cancelled", "fenced"] as const) {
    const fixture = durableWorkFixture();
    try {
      const scope = fixture.turn(
        `turn-bound-stop-${state}`,
        `session-bound-stop-${state}`,
        "중단된 Turn에서는 새 Work 결과를 기록하지 마세요.",
      );
      const opened = await fixture.service.replacePlan(
        planInput(scope, `bound-stop-${state}-plan`),
      );
      fixture.tool(scope.turnId, `bound-stop-${state}-read`, "read_file", {
        content: "late result",
      });
      fixture.db.query(`
        UPDATE btcc_turns SET semantic_state = ?, execution_fence = execution_fence + 1,
          final_disposition = ? WHERE turn_id = ?
      `).run(
        state === "cancelled" ? "cancelled" : "admitted",
        state === "cancelled" ? "cancelled" : null,
        scope.turnId,
      );
      const counts = {
        results: fixture.count("btcc_guided_work_results"),
        checkpoints: fixture.count("btcc_guided_work_checkpoint_revisions"),
        reviews: fixture.count("btcc_guided_work_review_revisions"),
      };

      await expect(fixture.service.attachToolResult({
        ...scope,
        mutationCallId: `bound-stop-${state}-attach`,
        toolCallId: `bound-stop-${state}-read`,
      })).rejects.toThrow("stopped or fenced");
      await expect(fixture.service.recordCheckpoint({
        ...scope,
        mutationCallId: `bound-stop-${state}-checkpoint`,
        nextStage: "review",
      })).rejects.toThrow("stopped or fenced");
      await expect(fixture.service.recordReview({
        ...scope,
        mutationCallId: `bound-stop-${state}-review`,
        subject: "plan",
        verdict: "accept",
        summary: "중단 이후에는 기록하지 않는다.",
        corrections: [],
      })).rejects.toThrow("stopped or fenced");

      expect(fixture.count("btcc_guided_work_results")).toBe(counts.results);
      expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(counts.checkpoints);
      expect(fixture.count("btcc_guided_work_review_revisions")).toBe(counts.reviews);
      expect(await fixture.service.boundWorkForTurn(scope.turnId)).toMatchObject({
        workId: opened.workId,
        status: "open",
        resultRefs: [],
      });
    } finally {
      fixture.close();
    }
  }
});

test("only completed ordinary results are eligible for relation backfill or attachment", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const fixture = durableWorkFixture();
    try {
      const scope = fixture.turn(
        `turn-ineligible-${status}`,
        `session-ineligible-${status}`,
        "실패한 결과는 Work에 연결하지 마세요.",
      );
      const callId = `ineligible-${status}-read`;
      fixture.tool(scope.turnId, callId, "read_file", { content: status });
      fixture.db.query(`
        UPDATE btcc_guided_tool_calls SET status = ?, error_code = ? WHERE call_id = ?
      `).run(status, `injected_${status}`, callId);

      await expect(fixture.service.startWork({
        ...scope,
        mutationCallId: `ineligible-${status}-relation`,
        objective: "실패 결과를 연결하지 않는다",
        backfillToolCallIds: [callId],
      })).rejects.toThrow("not eligible for attachment");
      expect(fixture.count("btcc_guided_works")).toBe(0);
      expect(fixture.count("btcc_guided_turn_work_bindings")).toBe(0);
      expect(fixture.count("btcc_guided_work_relation_commands")).toBe(0);

      const opened = await fixture.service.startWork({
        ...scope,
        mutationCallId: `ineligible-${status}-bind`,
        objective: "연결할 Work를 준비한다",
      });
      await expect(fixture.service.attachToolResult({
        ...scope,
        mutationCallId: `ineligible-${status}-attach`,
        toolCallId: callId,
      })).rejects.toThrow("not eligible for attachment");
      expect(fixture.count("btcc_guided_work_results")).toBe(0);
      expect(await fixture.service.boundWorkForTurn(scope.turnId)).toMatchObject({
        workId: opened.workId,
        resultRefs: [],
      });
    } finally {
      fixture.close();
    }
  }
});

test("invalid stage transitions leave the current stage and action progress unchanged", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-invalid-transition",
      "session-invalid-transition",
      "보고서를 작성해 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(scope, "invalid-transition-plan"),
    );

    await expect(fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "invalid-transition-call",
      nextStage: "reporting",
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
    })).rejects.toThrow("allowed next stages: review");

    const unchanged = await fixture.service.loadContext(scope);
    expect(unchanged?.work).toMatchObject({
      currentStage: "planning",
      allowedNextStages: ["review"],
      actionProgress: [{ actionKey: "write-report", status: "pending" }],
      latestCheckpoint: { revision: opened.latestCheckpoint?.revision },
    });
  } finally {
    fixture.close();
  }
});

test("fresh Turns continue only the exact Session head scope and startNew preserves history", async () => {
  const fixture = durableWorkFixture();
  try {
    const first = fixture.turn("turn-project-a", "session-project", "프로젝트 A 작업");
    const firstView = await fixture.service.replacePlan({
      ...planInput(first, "project-a-plan"),
      projectRef: "project-a",
    });
    const next = fixture.turn("turn-project-b", "session-project", "프로젝트 B 작업");
    expect(await fixture.service.loadContext({
      ...next,
      projectRef: "project-b",
    })).toBeNull();
    expect(await fixture.service.loadContext(next)).toBeNull();
    await expect(fixture.service.continueWork({
      ...next,
      projectRef: "project-b",
      mutationCallId: "project-b-wrong-scope-continue",
      workId: firstView.workId,
    })).rejects.toThrow("current open Work");
    await expect(fixture.service.replacePlan({
      ...planInput(next, "project-b-implicit"),
      projectRef: "project-b",
    })).rejects.toThrow("scope changed; startNew is required");
    expect(await fixture.service.boundWorkForTurn(next.turnId)).toBeNull();

    const secondView = await fixture.service.replacePlan({
      ...planInput(next, "project-b-explicit"),
      projectRef: "project-b",
      startNew: true,
    });
    expect(secondView.workId).not.toBe(firstView.workId);
    expect(secondView.scope).toEqual({ kind: "project", projectRef: "project-b" });
    expect((await fixture.service.boundWorkForTurn(first.turnId))?.status)
      .toBe("abandoned");
    expect(fixture.count("btcc_guided_works")).toBe(2);
    expect(fixture.count("btcc_guided_work_plan_revisions")).toBe(2);

    const continuation = {
      ...fixture.turn(
        "turn-project-b-continue",
        "session-project",
        "계속 진행해 주세요.",
      ),
      projectRef: "project-b",
    };
    const continued = await fixture.service.replacePlan({
      ...planInput(continuation, "project-b-plan-2"),
      projectRef: "project-b",
      objective: "프로젝트 B 작업을 검토까지 완료한다",
    });
    expect(continued.workId).toBe(secondView.workId);
    expect(continued.currentPlan?.revision).toBe(2);
    expect((await fixture.service.loadContext(continuation))?.originalRequest.content)
      .toBe("프로젝트 B 작업");
  } finally {
    fixture.close();
  }
});

test("a fresh Turn cannot replace Work after committing its continuation", async () => {
  const fixture = durableWorkFixture();
  try {
    const origin = fixture.turn(
      "turn-continuation-origin",
      "session-continuation-lock",
      "초안을 만들고 다음 턴에 검증해 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(origin, "continuation-origin-plan"),
    );
    await fixture.service.recordCheckpoint({
      ...origin,
      mutationCallId: "continuation-origin-review-stage",
      nextStage: "review",
    });

    const continuation = fixture.turn(
      "turn-continuation-resume",
      "session-continuation-lock",
      "이어서 검증하고 마무리해 주세요.",
    );
    expect((await fixture.service.continueWork({
      ...continuation,
      mutationCallId: "continuation-resume-bind",
      workId: opened.workId,
    })).workId).toBe(opened.workId);
    await fixture.service.recordCheckpoint({
      ...continuation,
      mutationCallId: "continuation-resume-execution",
      nextStage: "execution",
      actionUpdates: [{ actionKey: "write-report", status: "active" }],
    });

    await expect(fixture.service.replacePlan({
      ...planInput(continuation, "contradictory-start-new"),
      startNew: true,
    })).rejects.toThrow("continuation is already committed for this Turn");

    expect(await fixture.service.boundWorkForTurn(continuation.turnId))
      .toMatchObject({ workId: opened.workId, status: "open" });
    expect((await fixture.service.loadContext(continuation))?.work.workId)
      .toBe(opened.workId);
    expect(fixture.count("btcc_guided_works")).toBe(1);
  } finally {
    fixture.close();
  }
});

test("a result attached in a fresh Turn commits the current Work identity", async () => {
  const fixture = durableWorkFixture();
  try {
    const origin = fixture.turn(
      "turn-result-origin",
      "session-result-lock",
      "파일을 확인하고 다음 턴에 이어서 정리해 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(origin, "result-origin-plan"),
    );
    const continuation = fixture.turn(
      "turn-result-resume",
      "session-result-lock",
      "파일 확인부터 이어서 진행해 주세요.",
    );
    expect((await fixture.service.continueWork({
      ...continuation,
      mutationCallId: "result-resume-bind",
      workId: opened.workId,
    })).workId).toBe(opened.workId);
    fixture.tool(
      continuation.turnId,
      "continuation-read-result",
      "read_file",
      { ok: true, content: "continued fact" },
    );
    await fixture.service.attachToolResult({
      ...continuation,
      mutationCallId: "attach-continuation-read-result",
      toolCallId: "continuation-read-result",
    });

    await expect(fixture.service.replacePlan({
      ...planInput(continuation, "start-new-after-result"),
      startNew: true,
    })).rejects.toThrow("continuation is already committed for this Turn");

    expect(await fixture.service.boundWorkForTurn(continuation.turnId))
      .toMatchObject({
        workId: opened.workId,
        status: "open",
        resultRefs: [{ toolCallId: "continuation-read-result" }],
      });
    expect(fixture.count("btcc_guided_works")).toBe(1);
  } finally {
    fixture.close();
  }
});

test("post-bind result attachment preserves journal order across out-of-order completion", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-out-of-order-results",
      "session-out-of-order-results",
      "두 결과를 실행 순서대로 보존해 주세요.",
    );
    const opened = await fixture.service.startWork({
      ...scope,
      mutationCallId: "out-of-order-bind",
      objective: "두 결과를 실행 순서대로 보존한다",
    });
    const journal = new SqliteGuidedToolJournal(fixture.db);
    journal.start({
      turnId: scope.turnId,
      callId: "journal-first",
      toolName: "read_file",
      rawArguments: "{}",
      arguments: {},
    });
    journal.start({
      turnId: scope.turnId,
      callId: "journal-second",
      toolName: "read_file",
      rawArguments: "{}",
      arguments: {},
    });
    journal.finish({
      callId: "journal-second",
      status: "completed",
      result: { content: "second completed first" },
    });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-journal-second",
      toolCallId: "journal-second",
    });
    journal.finish({
      callId: "journal-first",
      status: "completed",
      result: { content: "first completed second" },
    });
    const ordered = await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-journal-first",
      toolCallId: "journal-first",
    });

    expect(ordered.workId).toBe(opened.workId);
    expect(ordered.resultRefs.map((result) => result.toolCallId)).toEqual([
      "journal-first",
      "journal-second",
    ]);
    expect(fixture.db.query<{
      tool_call_id: string;
      sequence: number;
      source_turn_sequence: number | null;
    }, [string]>(`
      SELECT tool_call_id, sequence, source_turn_sequence
      FROM btcc_guided_work_results WHERE work_id = ?
      ORDER BY sequence
    `).all(opened.workId)).toEqual([
      { tool_call_id: "journal-second", sequence: 1, source_turn_sequence: 2 },
      { tool_call_id: "journal-first", sequence: 2, source_turn_sequence: 1 },
    ]);

    const replay = await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-journal-first",
      toolCallId: "journal-first",
    });
    expect(replay.resultRefs.map((result) => result.toolCallId)).toEqual([
      "journal-first",
      "journal-second",
    ]);
    expect((await fixture.service.loadContext(scope))?.resultFacts).toEqual([
      { toolName: "read_file", status: "completed", resultJson: { content: "first completed second" } },
      { toolName: "read_file", status: "completed", resultJson: { content: "second completed first" } },
    ]);
  } finally {
    fixture.close();
  }
});

test("tool results stay in the journal, bind to checkpoints, and exclude Work controls", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn("turn-results", "session-results", "두 파일을 비교해 주세요.");
    await fixture.service.replacePlan(planInput(scope, "results-plan"));
    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "results-plan-review-stage",
      nextStage: "review",
    });
    await fixture.service.recordReview({
      ...scope,
      mutationCallId: "results-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "현재 계획으로 진행합니다.",
      corrections: [],
    });
    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "results-execution-stage-1",
      nextStage: "execution",
    });
    fixture.tool(scope.turnId, "read-call-1", "read_file", { content: "alpha" });
    const attached = await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-call-1",
      toolCallId: "read-call-1",
    });
    expect(attached.resultRefs[0]).toMatchObject({
      toolCallId: "read-call-1",
      toolName: "read_file",
      status: "completed",
    });
    const firstCheckpoint = await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "checkpoint-call-1",
      nextStage: "review",
      publicSummary: "첫 파일을 읽었습니다.",
      nextStep: "두 번째 파일을 읽습니다.",
    });
    expect(firstCheckpoint.latestCheckpoint?.referencedResultRefs)
      .toEqual([attached.resultRefs[0]!.resultRef]);

    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "results-execution-stage-2",
      nextStage: "execution",
    });
    fixture.tool(scope.turnId, "read-call-2", "read_file", { content: "beta" });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-call-2",
      toolCallId: "read-call-2",
    });
    const secondCheckpoint = await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "checkpoint-call-2",
      nextStage: "review",
      publicSummary: "두 결과를 비교했습니다.",
      nextStep: "차이를 보고합니다.",
    });
    expect(secondCheckpoint.latestCheckpoint?.referencedResultRefs)
      .toEqual([secondCheckpoint.resultRefs[1]!.resultRef]);
    expect((await fixture.service.loadContext(scope))?.resultFacts).toEqual([
      { toolName: "read_file", status: "completed", resultJson: { content: "alpha" } },
      { toolName: "read_file", status: "completed", resultJson: { content: "beta" } },
    ]);
    expect(fixture.columns("btcc_guided_work_results")).not.toContain("result_json");

    for (const [index, toolName] of [
      "replace_work_plan",
      "record_work_checkpoint",
      "record_work_review",
    ].entries()) {
      const toolCallId = `work-control-call-${index}`;
      fixture.tool(scope.turnId, toolCallId, toolName, { ok: true });
      await expect(fixture.service.attachToolResult({
        ...scope,
        mutationCallId: `attach-control-${index}`,
        toolCallId,
      })).rejects.toThrow("control result cannot be attached");
    }
    expect(fixture.count("btcc_guided_work_results")).toBe(2);
  } finally {
    fixture.close();
  }
});

test("a committed Turn tool result backfills once after storage restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-backfill-"));
  const dbPath = join(root, "butler.sqlite");
  const scope = {
    turnId: "turn-backfill",
    sessionId: "session-backfill",
  };
  let db: Database | null = new Database(dbPath);
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const firstService = createDurableWorkService(new SqliteGuidedWorkStore(db));
    const firstJournal = new SqliteGuidedToolJournal(db);
    const origin = insertGuidedTurn(
      db,
      "turn-backfill-origin",
      scope.sessionId,
      "파일을 읽고 결과를 정리해 주세요.",
    );
    const opened = await firstService.replacePlan(
      planInput(origin, "backfill-plan"),
    );
    insertGuidedTurn(
      db,
      scope.turnId,
      scope.sessionId,
      "열린 작업을 이어서 파일을 확인해 주세요.",
    );
    expect((await firstService.loadContext(scope))?.work.workId).toBe(opened.workId);
    expect((await firstService.continueWork({
      ...scope,
      mutationCallId: "backfill-explicit-continue",
      workId: opened.workId,
    })).workId).toBe(opened.workId);
    firstJournal.start({
      turnId: scope.turnId,
      callId: "backfill-read",
      toolName: "read_file",
      rawArguments: JSON.stringify({ path: "fact.txt" }),
      arguments: { path: "fact.txt" },
    });
    firstJournal.finish({
      callId: "backfill-read",
      status: "completed",
      result: { content: "observed before interruption" },
    });
    expect((await firstService.boundWorkForTurn(scope.turnId))?.resultRefs).toEqual([]);
    db.close();
    db = null;

    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const resumedService = createDurableWorkService(new SqliteGuidedWorkStore(db));
    const resumedJournal = new SqliteGuidedToolJournal(db);
    await backfillTurnToolResults({
      durableWork: resumedService,
      toolJournal: resumedJournal,
    }, scope);
    await backfillTurnToolResults({
      durableWork: resumedService,
      toolJournal: resumedJournal,
    }, scope);

    expect((await resumedService.boundWorkForTurn(scope.turnId))?.resultRefs)
      .toEqual([expect.objectContaining({
        toolCallId: "backfill-read",
        toolName: "read_file",
        status: "completed",
      })]);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_work_results
    `).get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_work_mutations
      WHERE operation = 'attach_tool_result'
    `).get()?.count).toBe(1);

    const next = insertGuidedTurn(
      db,
      "turn-after-backfill",
      scope.sessionId,
      "직전 결과를 이어서 알려 주세요.",
    );
    expect((await resumedService.loadContext(next))?.resultFacts).toEqual([{
      toolName: "read_file",
      status: "completed",
      resultJson: { content: "observed before interruption" },
    }]);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("continuation keeps every result ref but bounds prompt facts to the latest 50", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-result-window",
      "session-result-window",
      "많은 자료를 확인해 주세요.",
    );
    await fixture.service.replacePlan(planInput(scope, "result-window-plan"));
    for (let index = 0; index < 55; index += 1) {
      const toolCallId = `window-read-${index}`;
      fixture.tool(scope.turnId, toolCallId, "read_file", { index });
      await fixture.service.attachToolResult({
        ...scope,
        mutationCallId: `window-attach-${index}`,
        toolCallId,
      });
    }

    const context = await fixture.service.loadContext(scope);
    expect(context?.work.resultRefs).toHaveLength(55);
    expect(context?.resultFacts).toHaveLength(50);
    expect(context?.resultFacts[0]?.resultJson).toEqual({ index: 5 });
    expect(context?.resultFacts[49]?.resultJson).toEqual({ index: 54 });
  } finally {
    fixture.close();
  }
});

test("one Plan Review call enters Review and advances to Execution idempotently", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-fused-plan-review",
      "session-fused-plan-review",
      "보고서를 작성해 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(scope, "fused-plan-review-plan"),
    );

    const input = {
      ...scope,
      mutationCallId: "fused-plan-review",
      subject: "plan" as const,
      verdict: "accept" as const,
      summary: "계획이 요청 결과와 검증을 직접 다룹니다.",
      corrections: [],
      nextStage: "execution" as const,
    };
    const reviewed = await fixture.service.recordReview(input);

    expect(reviewed).toMatchObject({
      currentStage: "execution",
      allowedNextStages: ["review"],
      actionProgress: [{ actionKey: "write-report", status: "pending" }],
      latestPlanReview: {
        verdict: "accept",
        boundPlanRevisionId: opened.currentPlan?.planRevisionId,
      },
      latestCheckpoint: { revision: 4, stage: "execution" },
    });
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(4);
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(1);

    const replay = await fixture.service.recordReview(input);
    expect(replay.latestCheckpoint?.checkpointRevisionId)
      .toBe(reviewed.latestCheckpoint?.checkpointRevisionId);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(4);
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(1);
    await expect(fixture.service.recordReview({
      ...input,
      summary: "같은 호출 식별자에 다른 판단을 기록합니다.",
    })).rejects.toThrow("mutation identity conflict");
  } finally {
    fixture.close();
  }
});

test("result Review stays open until completion Validation reports and completes Work", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-fused-result-review",
      "session-fused-result-review",
      "보고서를 작성하고 확인해 주세요.",
    );
    await fixture.service.replacePlan(planInput(scope, "fused-result-plan"));
    await fixture.service.recordReview({
      ...scope,
      mutationCallId: "fused-result-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "실행 가능한 계획입니다.",
      corrections: [],
      nextStage: "execution",
    });
    fixture.tool(scope.turnId, "fused-result-write", "write_file", {
      path: "report.md",
      ok: true,
    });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "fused-result-attach",
      toolCallId: "fused-result-write",
    });

    const resultReviewInput = {
      ...scope,
      mutationCallId: "fused-result-review",
      subject: "result" as const,
      verdict: "accept" as const,
      summary: "요청한 보고서를 작성하고 실제 결과를 확인했습니다.",
      corrections: [],
      actionUpdates: [{
        actionKey: "write-report",
        status: "done" as const,
        note: "보고서 작성과 확인을 마쳤습니다.",
      }],
    };
    const reviewedResult = await fixture.service.recordReview(resultReviewInput);

    expect(reviewedResult).toMatchObject({
      status: "open",
      currentStage: "review",
      actionProgress: [{
        actionKey: "write-report",
        status: "done",
        note: "보고서 작성과 확인을 마쳤습니다.",
      }],
      latestCheckpoint: { revision: 5, stage: "review" },
      latestResultReview: {
        verdict: "accept",
        boundResultRefs: [expect.any(String)],
      },
    });
    const completionInput = {
      ...scope,
      mutationCallId: "fused-completion-validation",
      subject: "completion" as const,
      verdict: "accept" as const,
      summary: "전체 Work가 원래 요청과 현재 Plan을 충족합니다.",
      corrections: [],
      nextStage: "reporting" as const,
    };
    const completed = await fixture.service.recordReview(completionInput);
    expect(completed).toMatchObject({
      status: "completed",
      currentStage: "reporting",
      latestCheckpoint: { revision: 7, stage: "reporting" },
      latestCompletionValidation: {
        verdict: "accept",
        boundResultReviewRevisionId:
          reviewedResult.latestResultReview?.reviewRevisionId,
      },
    });
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(3);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(7);
    const persistedStages = fixture.db.query<{ stage: string }, [string]>(`
      SELECT stage FROM btcc_guided_work_checkpoint_revisions
      WHERE work_id = ? ORDER BY revision ASC
    `).all(completed.workId).map((row) => row.stage);
    expect(persistedStages).toEqual([
      "conception",
      "planning",
      "review",
      "execution",
      "review",
      "validation",
      "reporting",
    ]);
    expect((await fixture.service.recordReview(completionInput)).status)
      .toBe("completed");
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(3);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(7);
  } finally {
    fixture.close();
  }
});

test("an invalid Review transition leaves Review and action progress untouched", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-invalid-fused-review",
      "session-invalid-fused-review",
      "보고서를 작성해 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(scope, "invalid-fused-review-plan"),
    );

    await expect(fixture.service.recordReview({
      ...scope,
      mutationCallId: "invalid-fused-review",
      subject: "plan",
      verdict: "accept",
      summary: "지원하지 않는 다음 단계로 이동합니다.",
      corrections: [],
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
      nextStage: "conception",
    })).rejects.toThrow("allowed next stages: planning, execution, validation");

    expect(await fixture.service.boundWorkForTurn(scope.turnId)).toEqual(opened);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(2);
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(0);
  } finally {
    fixture.close();
  }
});

test("a Review transaction rolls back its progress when Review persistence fails", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-atomic-fused-review",
      "session-atomic-fused-review",
      "보고서를 작성해 주세요.",
    );
    await fixture.service.replacePlan(planInput(scope, "atomic-fused-review-plan"));
    fixture.db.exec(`
      CREATE TRIGGER reject_fused_review
      BEFORE INSERT ON btcc_guided_work_review_revisions
      BEGIN
        SELECT RAISE(ABORT, 'simulated review persistence failure');
      END
    `);
    const input = {
      ...scope,
      mutationCallId: "atomic-fused-review",
      subject: "plan" as const,
      verdict: "accept" as const,
      summary: "계획을 검토했습니다.",
      corrections: [],
      actionUpdates: [{ actionKey: "write-report", status: "active" as const }],
      nextStage: "execution" as const,
    };

    await expect(fixture.service.recordReview(input))
      .rejects.toThrow("simulated review persistence failure");
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(2);
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(0);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))?.actionProgress)
      .toEqual([{ actionKey: "write-report", status: "pending" }]);

    fixture.db.exec("DROP TRIGGER reject_fused_review");
    const retried = await fixture.service.recordReview(input);
    expect(retried).toMatchObject({
      currentStage: "execution",
      actionProgress: [{ actionKey: "write-report", status: "active" }],
      latestPlanReview: { verdict: "accept" },
    });
  } finally {
    fixture.close();
  }
});

test("Reviews bind runtime revisions and completion Validation completes Work", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn("turn-review", "session-review", "산출물을 작성해 주세요.");
    const reviewPlan = (mutationCallId: string) => ({
      ...planInput(scope, mutationCallId),
      actions: [{
        actionKey: "write-report",
        description: "보고서를 작성한다",
        dependencyKeys: [],
      }, {
        actionKey: "optional-polish",
        description: "선택적인 표현 개선을 검토한다",
        dependencyKeys: ["write-report"],
      }],
    });
    const firstPlan = await fixture.service.replacePlan(reviewPlan("review-plan-1"));
    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "review-plan-stage-1",
      nextStage: "review",
    });
    const acceptedPlan = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "plan-review-1",
      subject: "plan",
      verdict: "accept",
      summary: "현재 계획으로 진행할 수 있습니다.",
      corrections: [],
    });
    expect(acceptedPlan.latestPlanReview?.boundPlanRevisionId)
      .toBe(firstPlan.currentPlan?.planRevisionId);

    const revisedPlan = await fixture.service.replacePlan({
      ...reviewPlan("review-plan-2"),
      objective: "산출물을 작성하고 실제 결과를 확인한다",
    });
    expect(revisedPlan.latestPlanReview?.verdict).toBe("accept");
    expect(revisedPlan.latestPlanReview?.boundPlanRevisionId)
      .not.toBe(revisedPlan.currentPlan?.planRevisionId);

    const unresolvedResultReview = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "result-review-before-current-plan-review",
      subject: "result",
      verdict: "accept",
      summary: "현재 Plan을 검토하지 않은 채 완료하려고 합니다.",
      corrections: [],
    });
    expect(unresolvedResultReview.status).toBe("open");
    expect(unresolvedResultReview.latestResultReview?.verdict).toBe("accept");
    expect(unresolvedResultReview.actionProgress.every((action) =>
      action.status === "pending",
    )).toBe(true);

    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "review-plan-stage-2",
      nextStage: "review",
    });
    const acceptedRevisedPlan = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "plan-review-2",
      subject: "plan",
      verdict: "accept",
      summary: "수정된 현재 계획으로 진행할 수 있습니다.",
      corrections: [],
    });
    expect(acceptedRevisedPlan.latestPlanReview?.boundPlanRevisionId)
      .toBe(revisedPlan.currentPlan?.planRevisionId);

    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "review-execution-stage",
      nextStage: "execution",
      actionUpdates: [{ actionKey: "write-report", status: "active" }],
    });
    fixture.tool(scope.turnId, "write-call", "write_file", { path: "report.md" });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-write",
      toolCallId: "write-call",
    });
    const resultProgress = await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "review-result-stage",
      nextStage: "review",
      actionUpdates: [{
        actionKey: "write-report",
        status: "done",
        note: "보고서를 작성하고 결과를 확인했습니다.",
      }, {
        actionKey: "optional-polish",
        status: "skipped",
        note: "요청 결과에 필요하지 않은 선택 개선입니다.",
      }],
    });
    expect(resultProgress.actionProgress).toEqual([{
      actionKey: "write-report",
      status: "done",
      note: "보고서를 작성하고 결과를 확인했습니다.",
    }, {
      actionKey: "optional-polish",
      status: "skipped",
      note: "요청 결과에 필요하지 않은 선택 개선입니다.",
    }]);
    const correction = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "result-review-revise",
      subject: "result",
      verdict: "revise",
      summary: "검증이 더 필요합니다.",
      corrections: ["파일 내용을 다시 읽습니다."],
    });
    expect(correction.status).toBe("open");
    expect(correction.latestResultReview?.boundResultRefs)
      .toEqual(correction.resultRefs.map((result) => result.resultRef));

    const acceptedResult = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "result-review-accept",
      subject: "result",
      verdict: "accept",
      summary: "요청한 결과를 확인했습니다.",
      corrections: [],
    });
    expect(acceptedResult.status).toBe("open");
    const completed = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "completion-validation-accept",
      subject: "completion",
      verdict: "accept",
      summary: "전체 Work가 원래 요청과 현재 Plan을 충족합니다.",
      corrections: [],
      nextStage: "reporting",
    });
    expect(completed.status).toBe("completed");
    expect(completed.latestCompletionValidation).toMatchObject({
      subject: "completion",
      verdict: "accept",
      boundResultReviewRevisionId:
        acceptedResult.latestResultReview?.reviewRevisionId,
    });
    const later = fixture.turn("turn-after-complete", "session-review", "다음 요청");
    expect(await fixture.service.loadContext(later)).toBeNull();

    fixture.tool(scope.turnId, "read-after-accept", "read_file", { content: "verified" });
    const reopened = await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-after-result-accept",
      toolCallId: "read-after-accept",
    });
    expect(reopened.status).toBe("open");
    expect(reopened.resultRefs).toHaveLength(2);
    expect(reopened.latestResultReview?.boundResultRefs).toHaveLength(1);
    expect((await fixture.service.loadContext(later))?.work.status).toBe("open");
  } finally {
    fixture.close();
  }
});

test("a late effect blocker keeps the accepted result Review and leaves Work blocked", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-blocked-review",
      "session-blocked-review",
      "외부 변경 결과를 검토해 주세요.",
    );
    await fixture.service.replacePlan(planInput(scope, "blocked-review-plan"));
    const ready = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "blocked-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "현재 계획으로 진행합니다.",
      corrections: [],
      nextStage: "execution",
    });
    fixture.db.query(`
      INSERT INTO btcc_guided_work_effect_blockers (
        blocker_id, source_turn_id, source_occurrence_id, session_id, work_id,
        capability, target, input_json, input_sha256, idempotency_key, detail,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'unresolved', ?)
    `).run(
      "blocker-review",
      scope.turnId,
      "occurrence-review",
      scope.sessionId,
      ready.workId,
      "publish",
      "remote:report",
      "input-sha",
      "idempotency-review",
      "The prior effect must be reconciled.",
      "2026-08-02T00:00:00.000Z",
    );
    fixture.db.query(`
      UPDATE btcc_guided_works SET status = 'blocked' WHERE work_id = ?
    `).run(ready.workId);

    const reviewed = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "blocked-result-review",
      subject: "result",
      verdict: "accept",
      summary: "The result itself is ready.",
      corrections: [],
      actionUpdates: [{
        actionKey: "write-report",
        status: "done",
        note: "결과 자체는 준비되었습니다.",
      }],
    });
    expect(reviewed).toMatchObject({
      status: "blocked",
      currentStage: "review",
      latestResultReview: { verdict: "accept" },
    });
    const validated = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "blocked-completion-validation",
      subject: "completion",
      verdict: "accept",
      summary: "The result is ready, but the effect blocker remains.",
      corrections: ["Reconcile the outstanding effect before claiming completion."],
      nextStage: "reporting",
    });

    expect(validated).toMatchObject({
      status: "blocked",
      currentStage: "reporting",
      actionProgress: [{
        actionKey: "write-report",
        status: "done",
        note: "결과 자체는 준비되었습니다.",
      }],
      latestCheckpoint: { stage: "reporting" },
      latestResultReview: {
        verdict: "accept",
        summary: "The result itself is ready.",
      },
      latestCompletionValidation: {
        verdict: "accept",
        summary: "The result is ready, but the effect blocker remains.",
      },
      effectBlockers: [{ blockerId: "blocker-review" }],
    });
  } finally {
    fixture.close();
  }
});

test("Reviews reject stale Plan, progress, and result snapshots", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-stale-review",
      "session-stale-review",
      "현재 결과만 검토해 주세요.",
    );
    const first = await fixture.service.replacePlan(
      planInput(scope, "stale-review-plan-1"),
    );
    const second = await fixture.service.replacePlan({
      ...planInput(scope, "stale-review-plan-2"),
      objective: "같은 요청을 더 간결한 계획으로 수행한다",
    });
    await expect(fixture.store.recordReview({
      ...scope,
      mutationCallId: "stale-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "This Review observed the first Plan.",
      corrections: [],
      expectedPlanRevisionId: first.currentPlan!.planRevisionId,
      expectedProgressRevision: first.latestCheckpoint!.revision,
      expectedResultSequence: 0,
      requestSha256: "stale-plan-review-request",
      currentStage: first.currentStage!,
      entryStage: "review",
      actionProgress: first.actionProgress,
      progressChanged: false,
      completeWork: false,
    })).rejects.toThrow("Plan changed before its Review");

    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "stale-progress-update",
      nextStage: "review",
    });
    await expect(fixture.store.recordReview({
      ...scope,
      mutationCallId: "stale-progress-review",
      subject: "plan",
      verdict: "accept",
      summary: "This Review observed older action progress.",
      corrections: [],
      expectedPlanRevisionId: second.currentPlan!.planRevisionId,
      expectedProgressRevision: second.latestCheckpoint!.revision,
      expectedResultSequence: 0,
      requestSha256: "stale-progress-review-request",
      currentStage: second.currentStage!,
      entryStage: "review",
      actionProgress: second.actionProgress,
      progressChanged: false,
      completeWork: false,
    })).rejects.toThrow("progress changed");

    const reviewed = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "current-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "The current Plan is ready.",
      corrections: [],
    });
    fixture.tool(scope.turnId, "late-read", "read_file", { content: "new fact" });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "late-read-attach",
      toolCallId: "late-read",
    });
    await expect(fixture.store.recordReview({
      ...scope,
      mutationCallId: "stale-result-review",
      subject: "result",
      verdict: "accept",
      summary: "This Review did not observe the late result.",
      corrections: [],
      expectedPlanRevisionId: reviewed.currentPlan!.planRevisionId,
      expectedProgressRevision: reviewed.latestCheckpoint!.revision,
      expectedResultSequence: reviewed.resultRefs.length,
      requestSha256: "stale-result-review-request",
      currentStage: reviewed.currentStage!,
      entryStage: "review",
      actionProgress: reviewed.actionProgress,
      progressChanged: false,
      completeWork: false,
    })).rejects.toThrow("results changed");
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(1);
  } finally {
    fixture.close();
  }
});

test("Stop changes Turn state without changing the bound Work", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn("turn-stop", "session-stop", "긴 작업을 시작해 주세요.");
    const opened = await fixture.service.replacePlan(planInput(scope, "stop-plan"));
    fixture.db.query(`
      UPDATE btcc_turns SET semantic_state = 'cancelled', final_disposition = 'cancelled'
      WHERE turn_id = ?
    `).run(scope.turnId);
    expect(await fixture.service.boundWorkForTurn(scope.turnId)).toEqual(opened);

    const continuation = fixture.turn(
      "turn-after-stop",
      "session-stop",
      "중단한 작업을 이어서 해 주세요.",
    );
    const context = await fixture.service.loadContext(continuation);
    expect(context?.work.workId).toBe(opened.workId);
    expect(context?.work.status).toBe("open");
  } finally {
    fixture.close();
  }
});

test("Work review waits for a concurrent shared SQLite writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-contention-"));
  const dbPath = join(root, "butler.sqlite");
  const db = new Database(dbPath, { create: true });
  coordinateSharedSqliteWriter(db);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const service = createDurableWorkService(new SqliteGuidedWorkStore(db));
  const scope = insertGuidedTurn(
    db,
    "turn-contention",
    "session-contention",
    "보고서를 작성해 주세요.",
  );
  try {
    await service.replacePlan(planInput(scope, "contention-plan"));
    await service.recordCheckpoint({
      ...scope,
      mutationCallId: "contention-review-stage",
      nextStage: "review",
    });
    await service.recordReview({
      ...scope,
      mutationCallId: "contention-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "현재 계획으로 진행합니다.",
      corrections: [],
    });
    await service.recordCheckpoint({
      ...scope,
      mutationCallId: "contention-execution-stage",
      nextStage: "execution",
    });
    await service.recordCheckpoint({
      ...scope,
      mutationCallId: "contention-result-stage",
      nextStage: "review",
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
    });
    const acceptedResult = await service.recordReview({
      ...scope,
      mutationCallId: "contention-result-review",
      subject: "result",
      verdict: "accept",
      summary: "요청한 결과를 확인했습니다.",
      corrections: [],
    });
    expect(acceptedResult.status).toBe("open");
    const child = spawn(process.execPath, ["-e", `
      import { Database } from "bun:sqlite";
      const db = new Database(process.env.TEST_DB_PATH);
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      await Bun.sleep(200);
      db.exec("COMMIT");
      db.close();
    `], {
      env: { ...process.env, TEST_DB_PATH: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");

    const completed = await service.recordReview({
      ...scope,
      mutationCallId: "contention-completion-validation",
      subject: "completion",
      verdict: "accept",
      summary: "전체 Work가 원래 요청과 현재 Plan을 충족합니다.",
      corrections: [],
      nextStage: "reporting",
    });

    expect(completed.status).toBe("completed");
    expect((await once(child, "exit"))[0]).toBe(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function durableWorkFixture(): {
  db: Database;
  service: DurableWorkService;
  store: DurableWorkStore;
  turn(turnId: string, sessionId: string, message: string): WorkTurnScope;
  tool(turnId: string, callId: string, name: string, result: unknown): void;
  count(table: string): number;
  columns(table: string): string[];
  close(): void;
} {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const store = new SqliteGuidedWorkStore(db);
  const service = createDurableWorkService(store);
  const journal = new SqliteGuidedToolJournal(db);
  return {
    db,
    service,
    store,
    turn(turnId, sessionId, message) {
      return insertGuidedTurn(db, turnId, sessionId, message);
    },
    tool(turnId, callId, name, result) {
      journal.start({
        turnId,
        callId,
        toolName: name,
        rawArguments: "{}",
        arguments: {},
      });
      journal.finish({ callId, status: "completed", result });
    },
    count(table) {
      return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()!.count;
    },
    columns(table) {
      return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
        .map((row) => row.name);
    },
    close() {
      db.close();
    },
  };
}

function insertGuidedTurn(
  db: Database,
  turnId: string,
  sessionId: string,
  message: string,
): WorkTurnScope {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', '{}', '{}', 'admitted', 1, 0)
  `).run(
    turnId,
    sessionId,
    `inbox-${turnId}`,
    `trigger-${turnId}`,
    `message-${turnId}`,
    message,
  );
  return { turnId, sessionId };
}

function planInput(
  scope: WorkTurnScope,
  mutationCallId: string,
): ReplaceWorkPlanInput {
  return {
    ...scope,
    mutationCallId,
    objective: "요청한 보고서를 작성한다",
    actions: [{
      actionKey: "write-report",
      description: "격리된 작업공간에 보고서를 작성한다",
      dependencyKeys: [],
      effect: { capability: "write_file", target: "workspace:report.md" },
    }],
    checks: ["보고서 내용을 확인한다"],
  };
}

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  createDurableWorkService,
  type WorkTurnScope,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  SqliteGuidedToolJournal,
  SqliteGuidedWorkStore,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";

test("six-stage Work persists Validation bindings and replay without duplicate rows", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const service = createDurableWorkService(new SqliteGuidedWorkStore(db));
  const journal = new SqliteGuidedToolJournal(db);
  const scope = insertTurn(db, "turn-six-stage", "session-six-stage");
  try {
    const planned = await service.replacePlan({
      ...scope,
      mutationCallId: "six-stage-plan",
      objective: "검증된 결과를 보고한다",
      actions: [{
        actionKey: "publish-result",
        description: "결과를 만들고 실제 적용 영수증을 확인한다",
        dependencyKeys: [],
      }],
      checks: ["실제 결과와 적용 영수증이 존재한다"],
    });
    expect(stages(db, planned.workId)).toEqual(["conception", "planning"]);

    await service.recordReview({
      ...scope,
      mutationCallId: "six-stage-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "현재 계획으로 실행할 수 있습니다.",
      corrections: [],
    });
    journal.start({
      turnId: scope.turnId,
      callId: "six-stage-effect-call",
      toolName: "write_file",
      rawArguments: "{}",
      arguments: {},
    });
    journal.finish({
      callId: "six-stage-effect-call",
      status: "completed",
      result: {
        ok: true,
        effect_receipt: {
          receipt_id: "receipt-six-stage",
          applied_at: "2026-08-02T00:00:00.000Z",
        },
      },
    });
    await service.attachToolResult({
      ...scope,
      mutationCallId: "six-stage-effect-result",
      toolCallId: "six-stage-effect-call",
    });

    const resultReviewed = await service.recordReview({
      ...scope,
      mutationCallId: "six-stage-result-review",
      subject: "result",
      verdict: "accept",
      summary: "결과와 적용 영수증을 확인했습니다.",
      corrections: [],
      actionUpdates: [{ actionKey: "publish-result", status: "done" }],
    });
    expect(resultReviewed).toMatchObject({
      status: "open",
      currentStage: "validation",
      latestResultReview: {
        subject: "result",
        verdict: "accept",
        boundResultRefs: [expect.any(String)],
      },
    });
    expect(resultReviewed.latestCompletionValidation).toBeUndefined();

    const completionInput = {
      ...scope,
      mutationCallId: "six-stage-completion-validation",
      subject: "completion" as const,
      verdict: "accept" as const,
      summary: "원 요청, 계획, 결과, 영수증을 대조해 완료를 확인했습니다.",
      corrections: [],
    };
    const validated = await service.recordReview(completionInput);
    expect(validated).toMatchObject({
      status: "open",
      currentStage: "reporting",
      latestCompletionValidation: {
        subject: "completion",
        verdict: "accept",
        boundPlanRevisionId: validated.currentPlan?.planRevisionId,
        boundResultReviewRevisionId:
          resultReviewed.latestResultReview?.reviewRevisionId,
        boundActionProgress: [{ actionKey: "publish-result", status: "done" }],
        boundResultRefs: validated.resultRefs.map((result) => result.resultRef),
      },
    });
    const dispositionInput = {
      ...scope,
      mutationCallId: "six-stage-disposition",
      workId: validated.workId,
      disposition: "completed" as const,
      summary: "검증 기록과 실제 결과를 명시적으로 닫았습니다.",
    };
    const completed = await service.recordDisposition(dispositionInput);
    expect(completed).toMatchObject({
      status: "completed",
      latestDisposition: {
        disposition: "completed",
        originTurnId: scope.turnId,
        runtimeOwnedOpen: false,
      },
    });
    expect(stages(db, completed.workId)).toEqual([
      "conception",
      "planning",
      "review",
      "execution",
    "review",
    "validation",
    "validation",
    "reporting",
      "reporting",
    ]);
    expect(reviewBinding(db, completed.workId)).toEqual({
      bound_plan_revision_id: completed.currentPlan!.planRevisionId,
      bound_result_sequence: 1,
      bound_result_review_revision_id:
        resultReviewed.latestResultReview!.reviewRevisionId,
      bound_action_states_json:
        '[{"actionKey":"publish-result","status":"done"}]',
    });

    const beforeReplay = counts(db);
    expect((await service.recordReview(completionInput)).status).toBe("completed");
    expect((await service.recordDisposition(dispositionInput)).status).toBe("completed");
    expect(counts(db)).toEqual(beforeReplay);
  } finally {
    db.close();
  }
});

test("R3-11 constraints migrate without rewriting completed Work history", async () => {
  const db = new Database(":memory:");
  db.exec(r3_11SuccessorSchema());
  db.exec(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES (
      'legacy-turn', 'legacy-session', 'legacy-inbox', 'legacy-trigger',
      'legacy-message', '기존 완료 작업', 'snapshot', '{}', '{}',
      'delivered', 1, 1
    );
    INSERT INTO btcc_guided_works (
      work_id, session_id, scope_kind, scope_ref, origin_turn_id,
      origin_message_id, objective, status, current_plan_revision_id,
      created_at, updated_at
    ) VALUES (
      'legacy-completed-work', 'legacy-session', 'session', 'legacy-session',
      'legacy-turn', 'legacy-message', '기존 완료 작업', 'completed',
      'legacy-plan', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at)
    VALUES ('legacy-session', 'legacy-completed-work', '2026-08-01T00:00:00.000Z');
    INSERT INTO btcc_guided_turn_work_bindings (
      binding_revision_id, turn_id, session_id, work_id, revision,
      is_current, bound_at
    ) VALUES (
      'legacy-binding', 'legacy-turn', 'legacy-session',
      'legacy-completed-work', 1, 1, '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO btcc_guided_work_plan_revisions (
      plan_revision_id, work_id, revision, objective, governing_refs_json,
      actions_json, checks_json, origin_turn_id, created_at
    ) VALUES (
      'legacy-plan', 'legacy-completed-work', 1, '기존 완료 작업', '[]',
      '[{"actionKey":"legacy-action","description":"기존 작업","dependencyKeys":[]}]',
      '[]', 'legacy-turn', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
      public_summary, next_step, action_states_json, result_sequence,
      origin_turn_id, created_at
    ) VALUES (
      'legacy-reporting', 'legacy-completed-work', 1, 'legacy-plan', 'reporting',
      '이미 보고한 결과', '', '[]', 1, 'legacy-turn',
      '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO btcc_guided_work_review_revisions (
      review_revision_id, work_id, revision, subject, verdict, summary,
      corrections_json, bound_plan_revision_id, bound_result_sequence,
      origin_turn_id, created_at
    ) VALUES (
      'legacy-result-review', 'legacy-completed-work', 1, 'result', 'accept',
      '기존 결과 리뷰', '[]', NULL, 1, 'legacy-turn',
      '2026-08-01T00:00:00.000Z'
    );
  `);

  migrateBtccSchema(db);
  migrateBtccSchema(db);

  expect(db.query<{
    name: string;
    dflt_value: string | null;
  }, []>("PRAGMA table_info(btcc_guided_work_disposition_revisions)").all()
    .find((column) => column.name === "runtime_owned_open"))
    .toMatchObject({ dflt_value: "0" });

  const legacy = await new SqliteGuidedWorkStore(db)
    .boundWorkForTurn("legacy-turn");
  expect(legacy).toMatchObject({
    status: "completed",
    currentStage: "reporting",
    latestResultReview: { reviewRevisionId: "legacy-result-review" },
  });
  expect(legacy?.latestCompletionValidation).toBeUndefined();
  expect(stages(db, "legacy-completed-work")).toEqual(["reporting"]);
  expect(db.query<{ subject: string }, []>(`
    SELECT subject FROM btcc_guided_work_review_revisions
    WHERE review_revision_id = 'legacy-result-review'
  `).get()?.subject).toBe("result");
  expect(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_guided_work_review_revisions
    WHERE subject = 'completion'
  `).get()?.count).toBe(0);

  db.exec(`
    INSERT INTO btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
      public_summary, next_step, action_states_json, result_sequence,
      origin_turn_id, created_at
    ) VALUES (
      'new-validation', 'legacy-completed-work', 2, 'legacy-plan', 'validation',
      '새 검토', '', '[]', 1, 'new-turn', '2026-08-02T00:00:00.000Z'
    );
    INSERT INTO btcc_guided_work_review_revisions (
      review_revision_id, work_id, revision, subject, verdict, summary,
      corrections_json, bound_plan_revision_id, bound_result_sequence,
      bound_result_review_revision_id, bound_action_states_json,
      origin_turn_id, created_at
    ) VALUES (
      'new-completion-validation', 'legacy-completed-work', 2, 'completion',
      'accept', '새 완료 검토', '[]', 'legacy-plan', 1,
      'legacy-result-review', '[]', 'new-turn', '2026-08-02T00:00:00.000Z'
    );
  `);
  expect(stages(db, "legacy-completed-work")).toEqual([
    "reporting",
    "validation",
  ]);
  db.close();
});

function insertTurn(db: Database, turnId: string, sessionId: string): WorkTurnScope {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, '결과를 만들고 검증해 주세요.', 'snapshot', '{}', '{}',
      'admitted', 1, 0)
  `).run(turnId, sessionId, `inbox-${turnId}`, `trigger-${turnId}`, `message-${turnId}`);
  return { turnId, sessionId };
}

function stages(db: Database, workId: string): string[] {
  return db.query<{ stage: string }, [string]>(`
    SELECT stage FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ? ORDER BY revision
  `).all(workId).map((row) => row.stage);
}

function reviewBinding(db: Database, workId: string) {
  return db.query<{
    bound_plan_revision_id: string;
    bound_result_sequence: number;
    bound_result_review_revision_id: string;
    bound_action_states_json: string;
  }, [string]>(`
    SELECT bound_plan_revision_id, bound_result_sequence,
      bound_result_review_revision_id, bound_action_states_json
    FROM btcc_guided_work_review_revisions
    WHERE work_id = ? AND subject = 'completion'
  `).get(workId);
}

function counts(db: Database) {
  return {
    checkpoints: count(db, "btcc_guided_work_checkpoint_revisions"),
    reviews: count(db, "btcc_guided_work_review_revisions"),
    mutations: count(db, "btcc_guided_work_mutations"),
  };
}

function count(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
    .get()!.count;
}

function r3_11SuccessorSchema(): string {
  return BTCC_SUCCESSOR_SCHEMA
    .replace(
      "stage IN ('conception', 'planning', 'execution', 'review', " +
        "'validation', 'reporting')",
      "stage IN ('conception', 'planning', 'execution', 'review', 'reporting')",
    )
    .replace(
      "subject TEXT NOT NULL CHECK (subject IN ('plan', 'result', 'completion'))",
      "subject TEXT NOT NULL CHECK (subject IN ('plan', 'result'))",
    )
    .replace("  bound_result_review_revision_id TEXT,\n", "")
    .replace("  bound_action_states_json TEXT,\n", "")
    .replace(
      "      AND bound_result_sequence IS NULL\n" +
        "      AND bound_result_review_revision_id IS NULL\n" +
        "      AND bound_action_states_json IS NULL)\n" +
        "    OR\n" +
        "    (subject = 'result' AND bound_plan_revision_id IS NULL\n" +
        "      AND bound_result_sequence IS NOT NULL\n" +
        "      AND bound_result_review_revision_id IS NULL\n" +
        "      AND bound_action_states_json IS NULL)\n" +
        "    OR\n" +
        "    (subject = 'completion' AND bound_plan_revision_id IS NOT NULL\n" +
        "      AND bound_result_sequence IS NOT NULL\n" +
        "      AND bound_result_review_revision_id IS NOT NULL\n" +
        "      AND bound_action_states_json IS NOT NULL)",
      "      AND bound_result_sequence IS NULL)\n" +
        "    OR\n" +
        "    (subject = 'result' AND bound_plan_revision_id IS NULL\n" +
        "      AND bound_result_sequence IS NOT NULL)",
    );
}

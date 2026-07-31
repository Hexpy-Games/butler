import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  createDurableWorkService,
  type DurableWorkService,
  type ReplaceWorkPlanInput,
  type WorkTurnScope,
} from "../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import {
  SqliteGuidedToolJournal,
  SqliteGuidedWorkStore,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

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

test("fresh Turns continue only the exact Session head scope and startNew preserves history", async () => {
  const fixture = durableWorkFixture();
  try {
    const first = fixture.turn("turn-project-a", "session-project", "프로젝트 A 작업");
    const firstView = await fixture.service.replacePlan({
      ...planInput(first, "project-a-plan"),
      projectRef: "project-a",
    });
    const next = fixture.turn("turn-project-b", "session-project", "프로젝트 B 작업");
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

    const continuation = fixture.turn(
      "turn-project-b-continue",
      "session-project",
      "계속 진행해 주세요.",
    );
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

test("tool results stay in the journal, bind to checkpoints, and exclude Work controls", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn("turn-results", "session-results", "두 파일을 비교해 주세요.");
    await fixture.service.replacePlan(planInput(scope, "results-plan"));
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
      stage: "execution",
      publicSummary: "첫 파일을 읽었습니다.",
      nextStep: "두 번째 파일을 읽습니다.",
    });
    expect(firstCheckpoint.latestCheckpoint?.referencedResultRefs)
      .toEqual([attached.resultRefs[0]!.resultRef]);

    fixture.tool(scope.turnId, "read-call-2", "read_file", { content: "beta" });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-call-2",
      toolCallId: "read-call-2",
    });
    const secondCheckpoint = await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "checkpoint-call-2",
      stage: "review",
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

test("Reviews bind runtime revisions, correction stays open, and accepted results complete Work", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn("turn-review", "session-review", "산출물을 작성해 주세요.");
    const firstPlan = await fixture.service.replacePlan(planInput(scope, "review-plan-1"));
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
      ...planInput(scope, "review-plan-2"),
      objective: "산출물을 작성하고 실제 결과를 확인한다",
    });
    expect(revisedPlan.latestPlanReview?.verdict).toBe("accept");
    expect(revisedPlan.latestPlanReview?.boundPlanRevisionId)
      .not.toBe(revisedPlan.currentPlan?.planRevisionId);

    await expect(fixture.service.recordReview({
      ...scope,
      mutationCallId: "result-review-before-current-plan-review",
      subject: "result",
      verdict: "accept",
      summary: "현재 Plan을 검토하지 않은 채 완료하려고 합니다.",
      corrections: [],
    })).rejects.toThrow("accepted Review of the current Plan");

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

    fixture.tool(scope.turnId, "write-call", "write_file", { path: "report.md" });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: "attach-write",
      toolCallId: "write-call",
    });
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

    const completed = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "result-review-accept",
      subject: "result",
      verdict: "accept",
      summary: "요청한 결과를 확인했습니다.",
      corrections: [],
    });
    expect(completed.status).toBe("completed");
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

function durableWorkFixture(): {
  db: Database;
  service: DurableWorkService;
  turn(turnId: string, sessionId: string, message: string): WorkTurnScope;
  tool(turnId: string, callId: string, name: string, result: unknown): void;
  count(table: string): number;
  columns(table: string): string[];
  close(): void;
} {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const service = createDurableWorkService(new SqliteGuidedWorkStore(db));
  const journal = new SqliteGuidedToolJournal(db);
  return {
    db,
    service,
    turn(turnId, sessionId, message) {
      db.query(`
        INSERT INTO btcc_turns (
          turn_id, session_id, inbox_id, trigger_key, original_message_id,
          original_message, admission_snapshot_ref, model_selection_json,
          context_json, continuation_snapshot_json, semantic_state,
          revision, execution_fence
        ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', '{}', '{}', '[]', 'admitted', 1, 1)
      `).run(
        turnId,
        sessionId,
        `inbox-${turnId}`,
        `trigger-${turnId}`,
        `message-${turnId}`,
        message,
      );
      return { turnId, sessionId };
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

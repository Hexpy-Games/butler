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
import { SqlitePrincipalAuthorityRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/authority-repository.ts";
import { createPrincipalAuthority } from
  "../../packages/butler-agent/src/agent/btcc/authority/index.ts";

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

test("invalid semantic Reviews leave the current stage and action progress unchanged", async () => {
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

    await expect(fixture.service.recordReview({
      ...scope,
      mutationCallId: "invalid-transition-call",
      subject: "result",
      verdict: "accept",
      summary: "결과가 완료되었습니다.",
      corrections: [],
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
    })).rejects.toMatchObject({
      code: "work_transition_guard_unmet",
      unmetGuard: "plan_review_required",
      nextAction: "record_plan_review",
    });

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
    await fixture.service.recordReview({
      ...scope,
      mutationCallId: "results-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "현재 계획으로 진행합니다.",
      corrections: [],
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
    const firstService = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
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
    const resumedService = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
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

test("record_work_disposition is atomic, idempotent, and the sole closeout authority", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-atomic-disposition",
      "session-atomic-disposition",
      "작업을 완료하고 닫아 주세요.",
    );
    const opened = await fixture.service.replacePlan(
      planInput(scope, "atomic-disposition-plan"),
    );
    fixture.tool(scope.turnId, "atomic-evidence-read", "read_file", {
      content: "verified result",
    });
    await expect(fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "invalid-disposition",
      workId: opened.workId,
      disposition: "completed",
      summary: "잘못된 근거로 완료합니다.",
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
      evidenceRefs: ["missing-evidence"],
    })).rejects.toThrow("evidence reference is not eligible");
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(0);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))?.status).toBe("open");

    const input = {
      ...scope,
      mutationCallId: "completed-disposition",
      workId: opened.workId,
      disposition: "completed" as const,
      summary: "요청한 작업을 완료했습니다.",
      actionUpdates: [{ actionKey: "write-report", status: "done" as const }],
      backfillToolCallIds: ["atomic-evidence-read"],
    };
    const completed = await fixture.service.recordDisposition(input);
    const evidenceResultRef = completed.resultRefs.find((result) =>
      result.toolCallId === "atomic-evidence-read")?.resultRef;
    expect(completed).toMatchObject({
      status: "completed",
      actionProgress: [{ actionKey: "write-report", status: "done" }],
      latestDisposition: {
        disposition: "completed",
        originTurnId: scope.turnId,
        evidenceRefs: [],
        evidenceSnapshot: [evidenceResultRef],
      },
    });
    expect((await fixture.service.recordDisposition(input)).status).toBe("completed");
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(1);
    expect(fixture.count("btcc_guided_work_disposition_commands")).toBe(1);
  } finally {
    fixture.close();
  }
});

test("disposition replay is idempotent across a SQLite restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-disposition-replay-"));
  const dbPath = join(root, "butler.sqlite");
  let db: Database | null = new Database(dbPath);
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const scope = insertGuidedTurn(
      db,
      "turn-disposition-restart",
      "session-disposition-restart",
      "재시작 후에도 닫아 주세요.",
    );
    const first = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
    const work = await first.replacePlan({
      ...planInput(scope, "disposition-restart-plan"),
      startNew: true,
    });
    const input = {
      ...scope,
      mutationCallId: "disposition-restart-call",
      workId: work.workId,
      disposition: "completed" as const,
      summary: "재시작 전 완료",
      actionUpdates: [{ actionKey: "write-report", status: "done" as const }],
    };
    const completed = await first.recordDisposition(input);
    db.close();
    db = null;
    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const resumed = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
    const replay = await resumed.recordDisposition(input);
    expect(replay.workId).toBe(completed.workId);
    expect(replay.latestDisposition?.dispositionRevisionId)
      .toBe(completed.latestDisposition?.dispositionRevisionId);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions
    `).get()?.count).toBe(1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("result Review and completion Validation stay open until disposition closes Work", async () => {
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
      currentStage: "validation",
      actionProgress: [{
        actionKey: "write-report",
        status: "done",
        note: "보고서 작성과 확인을 마쳤습니다.",
      }],
      latestCheckpoint: { revision: 6, stage: "validation" },
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
    };
    const validated = await fixture.service.recordReview(completionInput);
    expect(validated).toMatchObject({
      status: "open",
      currentStage: "reporting",
      latestCheckpoint: { revision: 8, stage: "reporting" },
      latestCompletionValidation: {
        verdict: "accept",
        boundResultReviewRevisionId:
          reviewedResult.latestResultReview?.reviewRevisionId,
      },
    });
    const completed = await fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "fused-completed-disposition",
      workId: validated.workId,
      disposition: "completed",
      summary: "전체 Work를 완료했습니다.",
    });
    expect(completed).toMatchObject({
      status: "completed",
      latestDisposition: { disposition: "completed" },
    });
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(3);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(9);
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
      "validation",
      "reporting",
      "reporting",
    ]);
    expect((await fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "fused-completed-disposition",
      workId: validated.workId,
      disposition: "completed",
      summary: "전체 Work를 완료했습니다.",
    })).status)
      .toBe("completed");
    expect(fixture.count("btcc_guided_work_review_revisions")).toBe(3);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(9);
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
      subject: "result",
      verdict: "accept",
      summary: "계획 검토 전에 결과 검토를 시도합니다.",
      corrections: [],
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
    })).rejects.toMatchObject({
      code: "work_transition_guard_unmet",
      unmetGuard: "plan_review_required",
      nextAction: "record_plan_review",
    });

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

test("Reviews bind runtime revisions while disposition remains the closeout authority", async () => {
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

    await fixture.service.recordReview({
      ...scope,
      mutationCallId: "result-review-return-to-planning",
      subject: "result",
      verdict: "revise",
      correctionScope: "planning",
      summary: "현재 계획을 수정해야 합니다.",
      corrections: ["검증 단계를 계획에 반영합니다."],
    });

    const revisedPlan = await fixture.service.replacePlan({
      ...reviewPlan("review-plan-2"),
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
    })).rejects.toMatchObject({
      code: "work_transition_guard_unmet",
      nextAction: "record_plan_review",
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
      correctionScope: "execution",
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
    const validated = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "completion-validation-accept",
      subject: "completion",
      verdict: "accept",
      summary: "전체 Work가 원래 요청과 현재 Plan을 충족합니다.",
      corrections: [],
    });
    expect(validated.status).toBe("open");
    expect(validated.latestCompletionValidation).toMatchObject({
      subject: "completion",
      verdict: "accept",
      boundResultReviewRevisionId:
        acceptedResult.latestResultReview?.reviewRevisionId,
    });
    const completed = await fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "completion-disposition-accept",
      workId: validated.workId,
      disposition: "completed",
      summary: "전체 Work를 완료했습니다.",
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
      currentStage: "validation",
      latestResultReview: { verdict: "accept" },
    });
    const validated = await fixture.service.recordReview({
      ...scope,
      mutationCallId: "blocked-completion-validation",
      subject: "completion",
      verdict: "accept",
      summary: "The result is ready, but the effect blocker remains.",
      corrections: ["Reconcile the outstanding effect before claiming completion."],
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
      nextStage: "execution",
      actionProgress: first.actionProgress,
      progressChanged: false,
    })).rejects.toThrow("Plan changed before its Review");

    await fixture.service.recordCheckpoint({
      ...scope,
      mutationCallId: "stale-progress-update",
      publicSummary: "진행 상태가 바뀌었습니다.",
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
      nextStage: "execution",
      actionProgress: second.actionProgress,
      progressChanged: false,
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
      nextStage: "validation",
      actionProgress: reviewed.actionProgress,
      progressChanged: false,
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

test("Work disposition waits for a concurrent shared SQLite writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-contention-"));
  const dbPath = join(root, "butler.sqlite");
  const db = new Database(dbPath, { create: true });
  coordinateSharedSqliteWriter(db);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const service = createDurableWorkService(new SqliteGuidedWorkStore(
    db,
    createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
  ));
  const scope = insertGuidedTurn(
    db,
    "turn-contention",
    "session-contention",
    "보고서를 작성해 주세요.",
  );
  try {
    await service.replacePlan(planInput(scope, "contention-plan"));
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
      mutationCallId: "contention-result-stage",
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

    const completed = await service.recordDisposition({
      ...scope,
      mutationCallId: "contention-completed-disposition",
      workId: acceptedResult.workId,
      disposition: "completed",
      summary: "전체 Work를 완료했습니다.",
    });

    expect(completed.status).toBe("completed");
    expect((await once(child, "exit"))[0]).toBe(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("record_work_disposition completes a bound Work without phase or Review gates", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-disposition-completed",
      "session-disposition-completed",
      "요청을 완료해 주세요.",
    );
    const started = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-completed-start",
      objective: "요청을 완료한다",
    });
    const completed = await fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-completed-call",
      workId: started.workId,
      disposition: "completed",
      summary: "요청을 완료했습니다.",
    });
    expect(completed.status).toBe("completed");
    expect(completed.latestDisposition).toMatchObject({
      disposition: "completed",
      summary: "요청을 완료했습니다.",
      originTurnId: scope.turnId,
    });
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(1);
    expect(fixture.count("btcc_guided_work_disposition_commands")).toBe(1);
    await expect(fixture.service.replacePlan({
      ...planInput(scope, "disposition-terminal-plan-attempt"),
      startNew: false,
    })).rejects.toThrow("terminal Work");
    expect(fixture.count("btcc_guided_works")).toBe(1);
  } finally {
    fixture.close();
  }
});

test("record_work_disposition atomically backfills evidence and writes the compatible checkpoint", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-disposition-evidence",
      "session-disposition-evidence",
      "근거를 모아 결과를 닫아 주세요.",
    );
    const started = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-evidence-start",
      objective: "근거를 모아 완료한다",
    });
    const planned = await fixture.service.replacePlan({
      ...planInput(scope, "disposition-evidence-plan"),
      objective: "근거를 모아 완료한다",
    });
    expect(planned.workId).toBe(started.workId);
    fixture.tool(scope.turnId, "disposition-evidence-read", "read_file", {
      content: "evidence",
    });
    const completed = await fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-evidence-call",
      workId: started.workId,
      disposition: "completed",
      summary: "읽은 근거를 반영했습니다.",
      actionUpdates: [{ actionKey: "write-report", status: "done" }],
      evidenceRefs: ["disposition-evidence-read"],
    });
    expect(completed.status).toBe("completed");
    expect(completed.resultRefs).toHaveLength(1);
    expect(completed.latestDisposition?.evidenceRefs).toEqual([
      "disposition-evidence-read",
    ]);
    expect(completed.latestDisposition?.evidenceSnapshot).toHaveLength(1);
    expect(completed.latestCheckpoint?.actionProgress).toEqual([
      { actionKey: "write-report", status: "done" },
    ]);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(3);
  } finally {
    fixture.close();
  }
});

test("open and blocked dispositions preserve an explicit continuation condition", async () => {
  const fixture = durableWorkFixture();
  try {
    const openScope = fixture.turn(
      "turn-disposition-open",
      "session-disposition-open",
      "계속 진행해 주세요.",
    );
    const openWork = await fixture.service.startWork({
      ...openScope,
      mutationCallId: "disposition-open-start",
      objective: "후속 작업을 진행한다",
    });
    const open = await fixture.service.recordDisposition({
      ...openScope,
      mutationCallId: "disposition-open-call",
      workId: openWork.workId,
      disposition: "open",
      summary: "후속 작업이 남았습니다.",
      remainingActions: ["검증 결과를 확인한다"],
    });
    expect(open.status).toBe("open");
    expect(open.latestDisposition?.remainingActions).toEqual([
      "검증 결과를 확인한다",
    ]);

    const blockedScope = fixture.turn(
      "turn-disposition-blocked",
      "session-disposition-blocked",
      "막힌 작업을 기록해 주세요.",
    );
    const blockedWork = await fixture.service.startWork({
      ...blockedScope,
      mutationCallId: "disposition-blocked-start",
      objective: "차단된 작업을 기록한다",
    });
    const blocked = await fixture.service.recordDisposition({
      ...blockedScope,
      mutationCallId: "disposition-blocked-call",
      workId: blockedWork.workId,
      disposition: "blocked",
      summary: "외부 확인이 필요합니다.",
      nextCondition: "외부 확인이 도착하면 다시 진행한다",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.latestDisposition?.nextCondition).toBe(
      "외부 확인이 도착하면 다시 진행한다",
    );
  } finally {
    fixture.close();
  }
});

test("invalid disposition evidence and material remaining actions leave no mutation", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-disposition-invalid",
      "session-disposition-invalid",
      "완료 근거를 확인해 주세요.",
    );
    const work = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-invalid-start",
      objective: "근거를 확인한다",
    });
    await expect(fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-invalid-evidence",
      workId: work.workId,
      disposition: "completed",
      summary: "근거가 있습니다.",
      evidenceRefs: ["missing-evidence"],
    })).rejects.toThrow("evidence reference");
    await expect(fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-invalid-remaining",
      workId: work.workId,
      disposition: "completed",
      summary: "아직 남은 작업이 있습니다.",
      remainingActions: ["아직 하지 않은 일"],
    })).rejects.toThrow("remaining actions");
    expect(fixture.count("btcc_guided_work_results")).toBe(0);
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(0);
    expect(fixture.count("btcc_guided_work_disposition_commands")).toBe(0);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))?.status).toBe("open");
  } finally {
    fixture.close();
  }
});

test("disposition replay is idempotent across a SQLite restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-disposition-replay-"));
  const dbPath = join(root, "butler.sqlite");
  let db: Database | null = new Database(dbPath);
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const scope = insertGuidedTurn(
      db,
      "turn-disposition-restart",
      "session-disposition-restart",
      "재시작 후에도 닫아 주세요.",
    );
    const first = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
    const work = await first.startWork({
      ...scope,
      mutationCallId: "disposition-restart-start",
      objective: "재시작 가능한 완료",
    });
    const input = {
      ...scope,
      mutationCallId: "disposition-restart-call",
      workId: work.workId,
      disposition: "completed" as const,
      summary: "재시작 전 완료",
    };
    const completed = await first.recordDisposition(input);
    db.close();
    db = null;
    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const resumed = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
    const replay = await resumed.recordDisposition(input);
    expect(replay.workId).toBe(completed.workId);
    expect(replay.latestDisposition?.dispositionRevisionId)
      .toBe(completed.latestDisposition?.dispositionRevisionId);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions
    `).get()?.count).toBe(1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disposition trigger failure rolls back evidence, checkpoint, revision, status, and receipt", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-disposition-rollback",
      "session-disposition-rollback",
      "원자적 닫기를 시험해 주세요.",
    );
    const work = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-rollback-start",
      objective: "원자적 닫기",
    });
    fixture.tool(scope.turnId, "disposition-rollback-read", "read_file", {
      content: "rollback evidence",
    });
    fixture.db.exec(`
      CREATE TRIGGER disposition_rollback
      BEFORE INSERT ON btcc_guided_work_disposition_revisions
      BEGIN SELECT RAISE(ABORT, 'disposition rollback'); END
    `);
    await expect(fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-rollback-call",
      workId: work.workId,
      disposition: "completed",
      summary: "이 트랜잭션은 롤백되어야 합니다.",
      evidenceRefs: ["disposition-rollback-read"],
    })).rejects.toThrow("disposition rollback");
    expect(fixture.count("btcc_guided_work_results")).toBe(0);
    expect(fixture.count("btcc_guided_work_checkpoint_revisions")).toBe(0);
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(0);
    expect(fixture.count("btcc_guided_work_disposition_commands")).toBe(0);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))?.status).toBe("open");
  } finally {
    fixture.close();
  }
});

test("completed disposition rejects nonterminal actions and unresolved effect state", async () => {
  const fixture = durableWorkFixture();
  try {
    const actionScope = fixture.turn(
      "turn-disposition-nonterminal",
      "session-disposition-nonterminal",
      "아직 끝나지 않은 작업을 닫지 마세요.",
    );
    const actionWork = await fixture.service.startWork({
      ...actionScope,
      mutationCallId: "disposition-nonterminal-start",
      objective: "끝나지 않은 작업",
    });
    await fixture.service.replacePlan({
      ...planInput(actionScope, "disposition-nonterminal-plan"),
      objective: "끝나지 않은 작업",
    });
    await expect(fixture.service.recordDisposition({
      ...actionScope,
      mutationCallId: "disposition-nonterminal-call",
      workId: actionWork.workId,
      disposition: "completed",
      summary: "완료했다고 잘못 선언합니다.",
    })).rejects.toThrow("nonterminal actions");
    expect((await fixture.service.boundWorkForTurn(actionScope.turnId))?.status)
      .toBe("open");

    const blockerScope = fixture.turn(
      "turn-disposition-blocker",
      "session-disposition-blocker",
      "효과 차단을 기록해 주세요.",
    );
    const blockerWork = await fixture.service.startWork({
      ...blockerScope,
      mutationCallId: "disposition-blocker-start",
      objective: "효과 차단을 기록한다",
    });
    fixture.db.query(`
      INSERT INTO btcc_guided_work_effect_blockers (
        blocker_id, source_turn_id, source_occurrence_id, session_id, work_id,
        capability, target, input_json, input_sha256, idempotency_key,
        detail, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)
    `).run(
      "disposition-blocker-row",
      blockerScope.turnId,
      "disposition-blocker-occurrence",
      blockerScope.sessionId,
      blockerWork.workId,
      "publish",
      "remote:report",
      "{}",
      "input-sha",
      "disposition-blocker-idempotency",
      "A pending publication must be reconciled.",
      new Date().toISOString(),
    );
    await expect(fixture.service.recordDisposition({
      ...blockerScope,
      mutationCallId: "disposition-blocker-call",
      workId: blockerWork.workId,
      disposition: "completed",
      summary: "차단이 있는데 닫지 마세요.",
    })).rejects.toThrow("effect blocker");

    const effectScope = fixture.turn(
      "turn-disposition-pending-effect",
      "session-disposition-pending-effect",
      "진행 중 효과를 닫지 마세요.",
    );
    const effectWork = await fixture.service.startWork({
      ...effectScope,
      mutationCallId: "disposition-pending-effect-start",
      objective: "진행 중 효과를 기록한다",
    });
    fixture.db.query(`
      INSERT INTO btcc_guided_effects (
        effect_id, receipt_id, idempotency_key, identity_sha256,
        request_sha256, input_sha256, target_sha256, work_id,
        plan_revision_id, action_key, capability, sanitized_target,
        status, journal_revision, dispatch_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, 0, ?, ?)
    `).run(
      "disposition-pending-effect",
      "disposition-pending-receipt",
      "disposition-pending-idempotency",
      "disposition-pending-identity",
      "disposition-pending-request",
      "disposition-pending-input",
      "disposition-pending-target",
      effectWork.workId,
      "missing-plan",
      "publish",
      "publish",
      "remote:report",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await expect(fixture.service.recordDisposition({
      ...effectScope,
      mutationCallId: "disposition-pending-effect-call",
      workId: effectWork.workId,
      disposition: "completed",
      summary: "진행 중 효과가 있는데 닫지 마세요.",
    })).rejects.toThrow("pending effect");
    expect((await fixture.service.boundWorkForTurn(effectScope.turnId))?.status)
      .toBe("open");
  } finally {
    fixture.close();
  }
});

test("failed or cancelled Turn results cannot satisfy disposition evidence", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-disposition-ineligible-results",
      "session-disposition-ineligible-results",
      "실패한 근거를 완료 근거로 쓰지 마세요.",
    );
    const work = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-ineligible-start",
      objective: "실패 근거를 검증한다",
    });
    const journal = new SqliteGuidedToolJournal(fixture.db);
    for (const [callId, status] of [
      ["disposition-failed-read", "failed"],
      ["disposition-cancelled-read", "cancelled"],
    ] as const) {
      journal.start({
        turnId: scope.turnId,
        callId,
        toolName: "read_file",
        rawArguments: "{}",
        arguments: {},
      });
      journal.finish({ callId, status, errorCode: status });
      await expect(fixture.service.recordDisposition({
        ...scope,
        mutationCallId: `${callId}-disposition`,
        workId: work.workId,
        disposition: "completed",
        summary: "실패한 근거로 완료를 선언합니다.",
        evidenceRefs: [callId],
      })).rejects.toThrow("evidence reference");
    }
    expect(fixture.count("btcc_guided_work_results")).toBe(0);
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(0);
  } finally {
    fixture.close();
  }
});

test("applied current Work effect receipts satisfy disposition evidence without duplicating effect authority", async () => {
  const fixture = durableWorkFixture();
  try {
    const scope = fixture.turn(
      "turn-disposition-applied-effect",
      "session-disposition-applied-effect",
      "적용된 효과 영수증을 완료 근거로 사용해 주세요.",
    );
    const work = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-applied-effect-start",
      objective: "적용된 효과를 근거로 닫는다",
    });
    fixture.db.query(`
      INSERT INTO btcc_guided_effects (
        effect_id, receipt_id, idempotency_key, identity_sha256,
        request_sha256, input_sha256, target_sha256, work_id,
        plan_revision_id, action_key, capability, sanitized_target,
        status, journal_revision, dispatch_attempts, result_json,
        receipt_json, created_at, updated_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', 1, 1,
        ?, ?, ?, ?, ?)
    `).run(
      "disposition-applied-effect-id",
      "disposition-applied-receipt",
      "disposition-applied-idempotency",
      "disposition-applied-identity",
      "disposition-applied-request",
      "disposition-applied-input",
      "disposition-applied-target",
      work.workId,
      "missing-plan",
      "write-report",
      "write_file",
      "workspace:report.md",
      "{\"written\":true}",
      "{\"receipt_id\":\"disposition-applied-receipt\"}",
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const completed = await fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-applied-effect-call",
      workId: work.workId,
      disposition: "completed",
      summary: "적용된 효과를 확인했습니다.",
      evidenceRefs: ["disposition-applied-receipt"],
    });
    expect(completed.status).toBe("completed");
    expect(completed.latestDisposition?.evidenceRefs).toEqual([
      "disposition-applied-receipt",
    ]);
    expect(completed.latestDisposition?.evidenceSnapshot).toEqual([
      "disposition-applied-receipt",
    ]);
    expect(fixture.count("btcc_guided_effects")).toBe(1);
  } finally {
    fixture.close();
  }
});

test("foreign or failed effect receipts cannot satisfy disposition evidence", async () => {
  const fixture = durableWorkFixture();
  try {
    const foreignScope = fixture.turn(
      "turn-disposition-effect-foreign",
      "session-disposition-effect-foreign",
      "외부 효과를 준비합니다.",
    );
    const foreign = await fixture.service.startWork({
      ...foreignScope,
      mutationCallId: "disposition-effect-foreign-start",
      objective: "외부 효과 Work",
    });
    const scope = fixture.turn(
      "turn-disposition-effect-invalid",
      "session-disposition-effect-invalid",
      "효과 소유권을 확인해 주세요.",
    );
    const target = await fixture.service.startWork({
      ...scope,
      mutationCallId: "disposition-effect-invalid-start",
      objective: "효과 소유권을 검증한다",
    });
    const insertEffect = (input: {
      effectId: string;
      receiptId: string;
      workId: string;
      status: "applied" | "failed";
    }) => {
      const applied = input.status === "applied";
      fixture.db.query(`
        INSERT INTO btcc_guided_effects (
          effect_id, receipt_id, idempotency_key, identity_sha256,
          request_sha256, input_sha256, target_sha256, work_id,
          plan_revision_id, action_key, capability, sanitized_target,
          status, journal_revision, dispatch_attempts, result_json,
          receipt_json, error_json, created_at, updated_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        input.effectId,
        input.receiptId,
        `${input.effectId}-idempotency`,
        `${input.effectId}-identity`,
        `${input.effectId}-request`,
        `${input.effectId}-input`,
        `${input.effectId}-target`,
        input.workId,
        "missing-plan",
        "write-report",
        "write_file",
        "workspace:report.md",
        input.status,
        applied ? '{"written":true}' : null,
        applied ? `{"receipt_id":"${input.receiptId}"}` : null,
        applied ? null : '{"code":"effect_dispatch_failed"}',
        new Date().toISOString(),
        new Date().toISOString(),
        applied ? new Date().toISOString() : null,
      );
    };
    insertEffect({
      effectId: "disposition-effect-foreign-id",
      receiptId: "disposition-effect-foreign-receipt",
      workId: foreign.workId,
      status: "applied",
    });
    await expect(fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-effect-foreign-call",
      workId: target.workId,
      disposition: "completed",
      summary: "외부 효과를 근거로 사용할 수 없습니다.",
      evidenceRefs: ["disposition-effect-foreign-receipt"],
    })).rejects.toThrow("evidence reference");

    insertEffect({
      effectId: "disposition-effect-failed-id",
      receiptId: "disposition-effect-failed-receipt",
      workId: target.workId,
      status: "failed",
    });
    await expect(fixture.service.recordDisposition({
      ...scope,
      mutationCallId: "disposition-effect-failed-call",
      workId: target.workId,
      disposition: "completed",
      summary: "실패한 효과를 근거로 사용할 수 없습니다.",
      evidenceRefs: ["disposition-effect-failed-receipt"],
    })).rejects.toThrow("evidence reference");

    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(0);
    expect(fixture.count("btcc_guided_work_disposition_commands")).toBe(0);
    expect((await fixture.service.boundWorkForTurn(scope.turnId))?.status)
      .toBe("open");
  } finally {
    fixture.close();
  }
});

test("disposition evidence cannot cite an ordinary result from an earlier Turn", async () => {
  const fixture = durableWorkFixture();
  try {
    const first = fixture.turn(
      "turn-disposition-evidence-first",
      "session-disposition-evidence-turns",
      "첫 Turn에서 근거를 읽습니다.",
    );
    const work = await fixture.service.startWork({
      ...first,
      mutationCallId: "disposition-evidence-first-start",
      objective: "현재 Work를 이어간다",
    });
    fixture.tool(first.turnId, "disposition-old-read", "read_file", {
      content: "old fact",
    });
    await fixture.service.attachToolResult({
      ...first,
      mutationCallId: "disposition-old-attach",
      toolCallId: "disposition-old-read",
    });
    const second = fixture.turn(
      "turn-disposition-evidence-second",
      first.sessionId,
      "다음 Turn에서 완료를 선언합니다.",
    );
    await fixture.service.continueWork({
      ...second,
      mutationCallId: "disposition-evidence-second-continue",
      workId: work.workId,
    });

    await expect(fixture.service.recordDisposition({
      ...second,
      mutationCallId: "disposition-old-evidence-call",
      workId: work.workId,
      disposition: "completed",
      summary: "오래된 Turn 근거는 현재 완료를 증명하지 않습니다.",
      evidenceRefs: ["disposition-old-read"],
    })).rejects.toThrow("evidence reference");
    expect(fixture.count("btcc_guided_work_disposition_revisions")).toBe(0);

    fixture.tool(second.turnId, "disposition-current-read", "read_file", {
      content: "current fact",
    });
    const completed = await fixture.service.recordDisposition({
      ...second,
      mutationCallId: "disposition-current-evidence-call",
      workId: work.workId,
      disposition: "completed",
      summary: "현재 Turn 근거로 완료했습니다.",
      evidenceRefs: ["disposition-current-read"],
    });
    expect(completed.status).toBe("completed");
    expect(completed.latestDisposition?.evidenceSnapshot).toHaveLength(1);
    expect((await fixture.service.recordDisposition({
      ...second,
      mutationCallId: "disposition-current-evidence-call",
      workId: work.workId,
      disposition: "completed",
      summary: "현재 Turn 근거로 완료했습니다.",
      evidenceRefs: ["disposition-current-read"],
    })).latestDisposition?.dispositionRevisionId)
      .toBe(completed.latestDisposition?.dispositionRevisionId);
  } finally {
    fixture.close();
  }
});

test("factual Work abandonment rolls back together with its exact-Work authority close", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const service = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
    const scope = insertGuidedTurn(
      db,
      "turn-abandon-authority-fault",
      "session-abandon-authority-fault",
      "작업을 중단하고 권한 요청도 닫아 주세요.",
    );
    const work = await service.replacePlan({
      ...planInput(scope, "abandon-authority-plan"),
      startNew: true,
    });
    const planRevisionId = db.query<
      { current_plan_revision_id: string },
      [string]
    >("SELECT current_plan_revision_id FROM btcc_guided_works WHERE work_id = ?")
      .get(work.workId)!.current_plan_revision_id;
    db.query(`
      INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, outcome,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "request-abandon-authority-fault",
      "authority-ref-abandon-fault",
      `identity-${work.workId}`,
      scope.sessionId,
      scope.sessionId,
      scope.turnId,
      work.workId,
      "workspace-command-abandoned",
      planRevisionId,
      "run-seeded-command",
      1,
      "run_command",
      "workspace-command:.",
      JSON.stringify({
        command: "printf 'abandoned-private-value'",
        cwd: ".",
        state_effect: "mutation",
      }),
      "openai/gpt-5.5",
      "low",
      "command",
      "Run one reviewed seeded command",
      "printf",
      1,
      "pending",
      "client-abandon-authority-fault-0000000000000000000",
      "Continue the approved operation exactly once.",
      "pending",
      "2026-08-23T09:00:00.000Z",
      "2026-08-23T09:00:00.000Z",
    );
    db.exec(`
      CREATE TRIGGER fault_abandoned_work_authority_close
      BEFORE UPDATE ON btcc_authority_requests
      WHEN NEW.close_reason IS NOT NULL AND OLD.close_reason IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'simulated abandoned Work authority close failure');
      END
    `);
    await expect(service.abandonBoundWorkForTurn(scope.turnId))
      .rejects.toThrow("simulated abandoned Work authority close failure");
    expect((await service.boundWorkForTurn(scope.turnId))?.workId)
      .toBe(work.workId);
    expect(db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_guided_works WHERE work_id = ?
    `).get(work.workId)?.status).not.toBe("abandoned");
    expect(db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM btcc_authority_requests
      WHERE source_work_id = ? AND decision = 'pending'
        AND close_reason IS NULL AND close_scope IS NULL AND closed_at IS NULL
    `).get(work.workId)?.count).toBe(1);

    db.exec("DROP TRIGGER fault_abandoned_work_authority_close");
    const abandoned = await service.abandonBoundWorkForTurn(scope.turnId);
    expect(abandoned).toMatchObject({
      workId: work.workId,
      status: "abandoned",
    });
    expect(db.query<{
      count: number;
    }, [string]>(`
      SELECT COUNT(*) AS count FROM btcc_authority_requests
      WHERE source_work_id = ? AND decision = 'pending'
        AND close_reason = 'work_abandoned' AND close_scope = 'work'
        AND closed_at IS NOT NULL
    `).get(work.workId)?.count).toBe(1);
  } finally {
    db.close();
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
  const store = new SqliteGuidedWorkStore(
    db,
    createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
  );
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

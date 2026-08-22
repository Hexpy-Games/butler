import { expect, test } from "bun:test";
import { TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER } from
  "../support/phase-continuity-private-digester.ts";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRecord, TurnStateRepository } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { DurableWorkService, DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { createTurnRuntime as createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { admitTurn } from
  "../../packages/butler-agent/src/agent/btcc/turn/admission/index.ts";
import {
  digest,
  stableJson,
} from "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { dispositionMaterialFingerprint } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import type {
  ModelRoundMessage,
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import {
  guidedOperationalFallback,
  runGuidedAgentLoopWithOperationalReport,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-report.ts";
import {
  currentTurnEffectRecords,
  operationalWorkFacts,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-facts.ts";
import { createGuidedOperationalProgressCapture } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-progress.ts";
import { createGuidedToolCallExecutor } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-call-execution.ts";
import { GuidedEffectProcessReplacementError } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { createGuidedRoundToolSurfaceResolver } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-round-tool-surface.ts";
import { prepareBtccToolCall } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-execution.ts";
import { createGuidedTurnCloseout } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-closeout.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tools.ts";
import { guidedToolOccurrence } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-occurrence.ts";
import { createToolCallToolHandler } from
  "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/executor.ts";
import { runCommandToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/run-command/run_command/definition.ts";
import type { ContextualButlerToolExecutor } from
  "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { createGuidedActivityProjection } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { authorizedToolDefinitions, isReplaySafeTool } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import { upsertMcpServer } from
  "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { buildModelRoute, ModelRouteDurabilityError } from
  "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";

test("substantial Butler work cannot settle as a promise-only direct reply", async () => {
  const records: Array<{ toolName: string }> = [];
  const closeout = createGuidedTurnCloseout({
    durableWork: {} as DurableWorkService,
    toolJournal: { list: () => records } as never,
    workScope: { turnId: "turn-delegation-gate", sessionId: "session-delegation-gate" },
    turnId: "turn-delegation-gate",
    trackingMode: "none",
    responseLanguage: "Korean",
    originalRequest: "이전 문서를 요구사항을 보존해서 수정해줘",
    subsessionRoutingRequired: true,
  });

  await expect(closeout.reviewFinalCandidate({ text: "수정하겠습니다." }))
    .resolves.toMatchObject({
      status: "continue",
      observation: expect.stringContaining("delegate_to_steward"),
    });
  expect(closeout.subsessionRoutingRepairRequired()).toBe(true);

  records.push({ toolName: "delegate_to_steward" });
  expect(closeout.subsessionRoutingRepairRequired()).toBe(false);
  await expect(closeout.reviewFinalCandidate({ text: "위임했습니다." }))
    .resolves.toEqual({ status: "accepted" });
});

type ScriptedModelRoundStep =
  | ModelRoundResult
  | ((request: ModelRoundRequest, index: number) =>
    ModelRoundResult | Promise<ModelRoundResult>);

function scriptedModelRound(
  steps: readonly ScriptedModelRoundStep[],
): ModelRoundPort {
  let index = 0;
  return {
    async runRound(request) {
      const step = steps[index];
      const currentIndex = index;
      index += 1;
      if (!step) throw new Error("scripted_model_round_exhausted");
      return typeof step === "function"
        ? await step(request, currentIndex)
        : step;
    },
  };
}

function toolCall(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): NonNullable<ModelRoundResult["toolCalls"]>[number] {
  return {
    id,
    name,
    arguments: arguments_,
    rawArguments: JSON.stringify(arguments_),
  };
}

function toolResponse(
  calls: Array<NonNullable<ModelRoundResult["toolCalls"]>[number]>,
  text?: string,
): ModelRoundResult {
  return { ...(text ? { text } : {}), toolCalls: calls };
}

function messagesWithToolResults(
  request: ModelRoundRequest,
): ModelRoundMessage[] {
  return request.messages.filter((message) => message.role === "tool");
}

function toolMessageOutput(message: ModelRoundMessage | undefined): unknown {
  if (!message) return undefined;
  const payload = JSON.parse(message.content) as {
    ok?: boolean;
    output?: unknown;
  };
  return payload.ok === false ? payload : payload.output;
}

test("real Guided Turn enters the BTCC agent-loop through the one-round port", async () => {
  const fixture = createFixture("guided-btcc-loop-entry");
  try {
    const requests: Array<{
      messages: readonly { role: string; content: string }[];
    }> = [];
    const modelRound: ModelRoundPort = {
      async runRound(request) {
        requests.push({
          messages: request.messages,
        });
        return { text: "BTCC final answer", toolCalls: [] };
      },
    };
    const agent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      effectJournal: fixture.stores.guidedEffectJournal,
      durableWork: fixture.stores.durableWork,
      modelRound,
    });

    const result = await agent.run({
      turn: turnRecord(fixture.root, { turnId: "guided-btcc-loop-entry" }),
      signal: new AbortController().signal,
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });

    expect(result.content).toBe("BTCC final answer");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("요청을 처리해 주세요"),
    });
  } finally {
    fixture.close();
  }
});

test("feature Guided Turn restores the existing bounded Work closeout opportunity", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-feature-closeout-restoration");
  try {
    const turnId = "guided-feature-closeout-restoration-turn";
    let modelCalls = 0;
    let dispositionOutput: unknown;
    const modelRound: ModelRoundPort = {
      async runRound(request) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return toolResponse([toolCall("closeout-plan", "replace_work_plan", {
            start_new: true,
            objective: "현재 Turn의 작업을 완료한다",
            actions: [{ action_key: "finish", dependency_keys: [] }],
            checks: [],
          })]);
        }
        if (modelCalls === 2) {
          return { text: "첫 번째 최종 후보", toolCalls: [] };
        }
        if (modelCalls === 3) {
          expect(request.tools.map((tool) => tool.name)).toContain(
            "record_work_disposition",
          );
          const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          expect(bound).not.toBeNull();
          return toolResponse([toolCall(
            "closeout-disposition",
            "record_work_disposition",
            {
              work_id: bound!.workId,
              disposition: "completed",
              summary: "현재 Turn의 작업을 완료했습니다.",
              action_updates: [{ action_key: "finish", status: "done" }],
            },
          )]);
        }
        const dispositionResult = messagesWithToolResults(request).find(
          (message) => message.name === "record_work_disposition",
        );
        expect(dispositionResult).toBeDefined();
        dispositionOutput = JSON.parse(dispositionResult!.content);
        return { text: "최종 답변", toolCalls: [] };
      },
    };
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: fixture.agent(modelRound),
    });

    const result = await runtime.runTurn(localRunCommand(fixture.root, turnId));

    expect(dispositionOutput).toMatchObject({
      ok: true,
      output: {
        ok: true,
        work: { status: "completed" },
      },
    });
    expect(result).toMatchObject({ kind: "delivered", content: "최종 답변" });
    expect(modelCalls).toBe(4);
    await expect(fixture.stores.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({
        status: "completed",
        latestDisposition: {
          originTurnId: turnId,
          disposition: "completed",
        },
      });
  } finally {
    fixture.close();
    if (previousSurface === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    }
  }
});

test("a terminal Turn fences late effects from reopening completed Work", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-completed-late-effect-closeout");
  const turnId = "guided-completed-late-effect-closeout-turn";
  try {
    let modelCalls = 0;
    const agent = fixture.agent({
      async runRound() {
        modelCalls += 1;
        if (modelCalls === 1) return toolResponse([toolCall("late-effect-plan", "replace_work_plan", {
          start_new: true,
          objective: "완료 뒤 늦은 effect를 다시 정산한다",
          actions: [{ action_key: "finish", dependency_keys: [] }],
          checks: [],
        })]);
        if (modelCalls === 2) return { text: "첫 완료 후보", toolCalls: [] };
        if (modelCalls === 3) {
          const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          return toolResponse([toolCall("late-effect-completed", "record_work_disposition", {
            work_id: bound!.workId,
            disposition: "completed",
            summary: "현재 결과를 완료했습니다.",
            action_updates: [{ action_key: "finish", status: "done" }],
          })]);
        }
        return { text: "완료된 답변", toolCalls: [] };
      },
    });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    await expect(runtime.runTurn(localRunCommand(fixture.root, turnId))).resolves
      .toMatchObject({ kind: "delivered", content: "완료된 답변" });
    const completed = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(completed).toMatchObject({
      status: "completed",
      latestDisposition: { disposition: "completed" },
    });
    expect(fixture.stores.guidedEffectJournal.prepare({
      effectId: "completed-late-effect",
      receiptId: "completed-late-effect-receipt",
      idempotencyKey: "completed-late-effect-key",
      identitySha256: "5".repeat(64),
      requestSha256: "6".repeat(64),
      inputSha256: "7".repeat(64),
      targetSha256: "8".repeat(64),
      workId: completed!.workId,
      planRevisionId: completed!.currentPlan!.planRevisionId,
      actionKey: "finish",
      capability: "write_file",
      sanitizedTarget: "workspace:late-effect.txt",
    })).toMatchObject({ ok: true, created: true });
    const closeout = createGuidedTurnCloseout({
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workScope: { turnId, sessionId: "guided-local-session" },
      turnId,
      trackingMode: "local",
      responseLanguage: "Korean",
      originalRequest: "완료 상태를 다시 확인해 주세요",
    });

    await expect(closeout.reconcileAfterLoop("늦은 effect 이후 후보"))
      .rejects.toThrow("Guided Work closeout could not persist an open disposition");
    await expect(fixture.stores.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({
        status: "completed",
        latestDisposition: {
          disposition: "completed",
          originTurnId: turnId,
        },
      });
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
  } finally {
    fixture.close();
    restoreEnv("BUTLER_PHASE_TOOL_SURFACE", previousSurface);
  }
});

test("ordinary open cannot reopen completed Work and a concurrent fresh completion wins", async () => {
  for (const scenario of ["ordinary-open", "fresh-completed"] as const) {
    const fixture = createFixture(`guided-completed-${scenario}`);
    try {
      const turnId = `guided-completed-${scenario}-turn`;
      await admitTurn(
        localRunCommand(fixture.root, turnId),
        fixture.stores.admission,
        fixture.stores.turns,
      );
      const planned = await fixture.stores.durableWork.replacePlan({
        turnId,
        sessionId: "guided-local-session",
        mutationCallId: `${scenario}-plan`,
        startNew: true,
        objective: "완료된 Work의 제한된 재개를 검증한다",
        actions: [{ actionKey: "finish", description: "finish", dependencyKeys: [] }],
        checks: [],
      });
      const completed = await fixture.stores.durableWork.recordDisposition({
        turnId,
        sessionId: "guided-local-session",
        mutationCallId: `${scenario}-completed`,
        workId: planned.workId,
        disposition: "completed",
        summary: "완료 상태를 기록했습니다.",
        actionUpdates: [{ actionKey: "finish", status: "done" }],
      });
      expect(completed.status).toBe("completed");
      await expect(fixture.stores.durableWork.claimCloseoutCorrection({
        turnId,
        sessionId: "guided-local-session",
        workId: "not-the-bound-work",
      })).rejects.toThrow("not bound to this Turn");
      if (scenario === "ordinary-open") {
        await expect(fixture.stores.durableWork.recordDisposition({
          turnId,
          sessionId: "guided-local-session",
          mutationCallId: "ordinary-model-open",
          workId: completed.workId,
          disposition: "open",
          summary: "일반 모델 open입니다.",
          nextCondition: "명시적인 후속 조건을 기다립니다.",
        })).rejects.toThrow("Durable Work is not open");
      } else {
        expect(fixture.stores.guidedEffectJournal.prepare({
          effectId: "fresh-completed-late-effect",
          receiptId: "fresh-completed-late-effect-receipt",
          idempotencyKey: "fresh-completed-late-effect-key",
          identitySha256: "9".repeat(64),
          requestSha256: "a".repeat(64),
          inputSha256: "b".repeat(64),
          targetSha256: "c".repeat(64),
          workId: completed.workId,
          planRevisionId: completed.currentPlan!.planRevisionId,
          actionKey: "finish",
          capability: "write_file",
          sanitizedTarget: "workspace:fresh.txt",
        })).toMatchObject({ ok: true, created: true });
        expect(fixture.stores.guidedEffectJournal.claimDispatch(
          "fresh-completed-late-effect",
          1,
        )).toMatchObject({ status: "dispatching" });
        expect(fixture.stores.guidedEffectJournal.recordFailed(
          "fresh-completed-late-effect",
          2,
          {
            code: "effect_dispatch_failed",
            message: "terminal",
            recoverable: false,
          },
        )).toMatchObject({ status: "failed" });
        const current = (await fixture.stores.durableWork.boundWorkForTurn(turnId))!;
        const currentFingerprint = dispositionMaterialFingerprint(current);
        let freshened = false;
        const base = fixture.stores.durableWork;
        const competingService: DurableWorkService = {
          ...base,
          recordDisposition: async (input) => {
            if (!freshened && input.runtimeOwnedOpenGeneration?.version === 1) {
              freshened = true;
              const db = new Database(fixture.dbPath);
              try {
                db.query(`
                  UPDATE btcc_guided_work_disposition_revisions
                  SET material_fingerprint = ? WHERE disposition_revision_id = ?
                `).run(
                  currentFingerprint,
                  current.latestDisposition!.dispositionRevisionId,
                );
              } finally {
                db.close(false);
              }
            }
            return base.recordDisposition(input);
          },
        };
        const closeout = createGuidedTurnCloseout({
          durableWork: competingService,
          toolJournal: fixture.stores.guidedToolJournal,
          workScope: { turnId, sessionId: "guided-local-session" },
          turnId,
          trackingMode: "local",
          responseLanguage: "Korean",
          originalRequest: "경쟁 완료를 보존해 주세요",
        });
        await expect(closeout.reconcileAfterLoop("경쟁 완료 후보"))
          .resolves.toBe("경쟁 완료 후보");
        await expect(base.boundWorkForTurn(turnId)).resolves.toMatchObject({
          status: "completed",
          latestDisposition: { disposition: "completed" },
        });
      }
      const db = new Database(fixture.dbPath);
      try {
        expect(db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions
        `).get()?.count).toBe(1);
      } finally {
        db.close(false);
      }
    } finally {
      fixture.close();
    }
  }
});

test("failed closeout correction persists open Work and delivers an explicit notice", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-feature-closeout-missing");
  try {
    const turnId = "guided-feature-closeout-missing-turn";
    let modelCalls = 0;
    const agent = fixture.agent({
      async runRound() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return toolResponse([toolCall("missing-plan", "replace_work_plan", {
            start_new: true,
            objective: "닫히지 않은 작업",
            actions: [{ action_key: "finish", dependency_keys: [] }],
            checks: [],
          })]);
        }
        if (modelCalls === 2) return { text: "첫 후보", toolCalls: [] };
        if (modelCalls === 3) {
          const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          return toolResponse([toolCall(
            "missing-disposition",
            "record_work_disposition",
            {
              work_id: bound!.workId,
              disposition: "completed",
              summary: "없는 근거로 잘못 닫기",
              action_updates: [{ action_key: "finish", status: "done" }],
              evidence_refs: ["missing-current-turn-evidence"],
            },
          )]);
        }
        return { text: "실패 후에도 전달할 최종 답변", toolCalls: [] };
      },
    });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });

    await expect(runtime.runTurn(localRunCommand(fixture.root, turnId))).resolves
      .toMatchObject({
        kind: "delivered",
        content: [
          "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
          "실패 후에도 전달할 최종 답변",
        ].join("\n\n"),
      });
    expect(modelCalls).toBe(4);
    const db = new Database(fixture.dbPath);
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_closeout_diagnostics
        WHERE code = 'closeout_missing' AND turn_id = ?
      `).get(turnId)?.count).toBe(1);
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions
      `).get()?.count).toBe(1);
      expect(db.query<{ status: string }, [string]>(`
        SELECT status FROM btcc_guided_works WHERE origin_turn_id = ?
      `).get(turnId)?.status).toBe("open");
    } finally {
      db.close(false);
    }
  } finally {
    fixture.close();
    if (previousSurface === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    }
  }
});

test("a late same-Turn result invalidates disposition and persists a fresh open closeout", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-stale-disposition-closeout");
  try {
    writeFileSync(join(fixture.root, "late.txt"), "late evidence\n");
    const turnId = "guided-stale-disposition-turn";
    let modelCalls = 0;
    const agent = fixture.agent({
      async runRound() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return toolResponse([toolCall("stale-plan", "replace_work_plan", {
            start_new: true,
            objective: "완료 선언 뒤 늦은 결과를 검증한다",
            actions: [{ action_key: "finish", dependency_keys: [] }],
            checks: [],
          })]);
        }
        if (modelCalls === 2) {
          return { text: "첫 번째 최종 후보", toolCalls: [] };
        }
        if (modelCalls === 3) {
          const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          return toolResponse([
            toolCall("stale-disposition", "record_work_disposition", {
              work_id: bound!.workId,
              disposition: "completed",
              summary: "현재까지의 Work를 완료했습니다.",
              action_updates: [{ action_key: "finish", status: "done" }],
            }),
            toolCall("stale-late-read", "read_file", { requests: [{ path: "late.txt" }] }),
          ]);
        }
        return { text: "늦은 결과까지 전달했습니다.", toolCalls: [] };
      },
    });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    await expect(runtime.runTurn(localRunCommand(fixture.root, turnId))).resolves
      .toMatchObject({
        kind: "delivered",
        content: [
          "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
          "늦은 결과까지 전달했습니다.",
        ].join("\n\n"),
      });
    expect(modelCalls).toBe(4);
    await expect(fixture.stores.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({
        status: "open",
        latestDisposition: {
          disposition: "open",
          originTurnId: turnId,
        },
      });
    const db = new Database(fixture.dbPath);
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count
        FROM btcc_guided_work_closeout_diagnostics
        WHERE code = 'closeout_missing' AND turn_id = ?
      `).get(turnId)?.count).toBe(1);
    } finally {
      db.close(false);
    }
  } finally {
    fixture.close();
    if (previousSurface === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    }
  }
});

test("closeout read and settlement-persistence failures leave final delivery rows absent", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  for (const failure of ["read", "diagnostic", "backfill", "persist"] as const) {
    const fixture = createFixture(`guided-closeout-${failure}-failure`);
    try {
      const turnId = `guided-closeout-${failure}-failure-turn`;
      let modelCalls = 0;
      let failRead = false;
      const base = fixture.stores.durableWork;
      const durableWork: DurableWorkService = {
        ...base,
        boundWorkForTurn: async (candidateTurnId) => {
          if (failure === "read" && failRead) throw new Error("closeout read failed");
          return base.boundWorkForTurn(candidateTurnId);
        },
        recordDisposition: async (input) => {
          if (failure === "persist" &&
              input.disposition === "open" && input.expectedMaterialFingerprint) {
            throw new Error("closeout persistence failed");
          }
          return base.recordDisposition(input);
        },
        claimCloseoutCorrection: async (input) => {
          if (failure === "diagnostic") {
            throw new Error("closeout diagnostic persistence failed");
          }
          return base.claimCloseoutCorrection(input);
        },
        attachToolResult: async (input) => {
          if (failure === "backfill" && input.toolCallId === "closeout-late-result") {
            throw new Error("closeout result backfill failed");
          }
          return base.attachToolResult(input);
        },
      };
      const agent = fixture.agent({
        async runRound() {
          modelCalls += 1;
          if (modelCalls === 1) return toolResponse([toolCall("failure-plan", "replace_work_plan", {
            start_new: true,
            objective: "종료 저장 실패를 검증한다",
            actions: [{ action_key: "finish", dependency_keys: [] }],
            checks: [],
          })]);
          if (failure === "backfill" && modelCalls === 3) {
            fixture.stores.guidedToolJournal.start({
              turnId,
              callId: "closeout-late-result",
              toolName: "read_file",
              rawArguments: stableJson({ path: "late.txt" }),
              arguments: { path: "late.txt" },
            });
            fixture.stores.guidedToolJournal.finish({
              callId: "closeout-late-result",
              status: "completed",
              result: { ok: true, content: "late" },
            });
          }
          if (failure === "read" || modelCalls >= 3) failRead = true;
          return { text: "저장되지 않아야 하는 최종 후보", toolCalls: [] };
        },
      }, { durableWork });
      const runtime = createGuidedTurnRuntime({
        admission: fixture.stores.admission,
        turns: fixture.stores.turns,
        messages: fixture.stores.messages,
        committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
        agent,
      });

      await expect(runtime.runTurn(localRunCommand(fixture.root, turnId))).rejects
        .toMatchObject({
          name: "GuidedWorkCloseoutError",
          code: "guided_work_closeout_persistence_failed",
        });
      expect(modelCalls).toBe(
        failure === "read" || failure === "diagnostic" ? 2 : 3,
      );
      const db = new Database(fixture.dbPath);
      try {
        expect(db.query<{
          final_payload_json: string | null;
          delivery_outbox_id: string | null;
        }, [string]>(`
          SELECT final_payload_json, delivery_outbox_id FROM btcc_turns
          WHERE turn_id = ?
        `).get(turnId)).toEqual({
          final_payload_json: null,
          delivery_outbox_id: null,
        });
        expect(db.query<{ count: number }, [string]>(`
          SELECT COUNT(*) AS count FROM btcc_delivery_outbox WHERE turn_id = ?
        `).get(turnId)?.count).toBe(0);
        expect(db.query<{ count: number }, [string]>(`
          SELECT COUNT(*) AS count FROM btcc_messages
          WHERE turn_id = ? AND role = 'assistant'
        `).get(turnId)?.count).toBe(0);
      } finally {
        db.close(false);
      }
    } finally {
      fixture.close();
    }
  }
  restoreEnv("BUTLER_PHASE_TOOL_SURFACE", previousSurface);
});

test("runtime-owned open closeout survives reopen while terminal Turns reject late material", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-closeout-open-reopen");
  const turnId = "guided-closeout-open-reopen-turn";
  let reopened: ReturnType<typeof openBtccSqliteStores> | undefined;
  let initialClosed = false;
  try {
    let modelCalls = 0;
    const agent = fixture.agent({
      async runRound() {
        modelCalls += 1;
        if (modelCalls === 1) return toolResponse([toolCall("reopen-plan", "replace_work_plan", {
          start_new: true,
          objective: "열린 종료 상태를 재시작 후 재사용한다",
          actions: [{ action_key: "finish", dependency_keys: [] }],
          checks: [],
        })]);
        return { text: "재시작 전 후보", toolCalls: [] };
      },
    });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    await expect(runtime.runTurn(localRunCommand(fixture.root, turnId))).resolves
      .toMatchObject({
        kind: "delivered",
        content: expect.stringContaining("Work를 열린 상태로 유지했습니다."),
      });
    expect(modelCalls).toBe(3);
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });

    fixture.stores.close();
    initialClosed = true;
    reopened = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId: "guided-closeout-open-reopened",
      storageProfile: "ephemeral",
    });
    const closeout = createGuidedTurnCloseout({
      durableWork: reopened.durableWork,
      toolJournal: reopened.guidedToolJournal,
      workScope: { turnId, sessionId: "guided-local-session" },
      turnId,
      trackingMode: "local",
      responseLanguage: "Korean",
      originalRequest: "열린 작업을 재확인해 주세요",
    });
    await expect(closeout.reviewFinalCandidate({ text: "재시작 후 후보" }))
      .resolves.toEqual({
        status: "accepted",
        text: [
          "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
          "재시작 후 후보",
        ].join("\n\n"),
      });
    await expect(closeout.reconcileAfterLoop("재시작 후 후보"))
      .resolves.toBe([
        "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
        "재시작 후 후보",
      ].join("\n\n"));
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
    await expect(reopened.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({
        status: "open",
        latestDisposition: {
          disposition: "open",
          originTurnId: turnId,
          runtimeOwnedOpen: true,
        },
      });
    reopened.guidedToolJournal.start({
      turnId,
      callId: "reopen-late-material",
      toolName: "read_file",
      rawArguments: stableJson({ path: "late.txt" }),
      arguments: { path: "late.txt" },
    });
    reopened.guidedToolJournal.finish({
      callId: "reopen-late-material",
      status: "completed",
      result: { ok: true, content: "late material" },
    });
    await expect(reopened.durableWork.attachToolResult({
      turnId,
      sessionId: "guided-local-session",
      mutationCallId: "attach-reopen-late-material",
      toolCallId: "reopen-late-material",
    })).rejects.toThrow("stopped or fenced");
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
  } finally {
    reopened?.close();
    if (!initialClosed) fixture.stores.close();
    rmSync(fixture.root, { recursive: true, force: true });
    restoreEnv("BUTLER_PHASE_TOOL_SURFACE", previousSurface);
  }
});

test("production closeout reuses its durable correction after crash and late material", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-closeout-crash-recovery");
  const turnId = "guided-closeout-crash-recovery-turn";
  let reopened: ReturnType<typeof openBtccSqliteStores> | undefined;
  let initialClosed = false;
  try {
    const turn = await admitTurn(
      localRunCommand(fixture.root, turnId),
      fixture.stores.admission,
      fixture.stores.turns,
    );
    let initialProviderCalls = 0;
    let correctionRequests = 0;
    const crashController = new AbortController();
    const simulatedCrash = new Error("simulated closeout correction crash");
    const firstAgent = fixture.agent({
      async runRound() {
        initialProviderCalls += 1;
        if (initialProviderCalls === 1) {
          return toolResponse([toolCall("crash-recovery-plan", "replace_work_plan", {
            start_new: true,
            objective: "재시작 뒤 종료 correction을 중복하지 않는다",
            actions: [{ action_key: "finish", dependency_keys: [] }],
            checks: [],
          })]);
        }
        if (initialProviderCalls === 2) return { text: "첫 후보", toolCalls: [] };
        correctionRequests += 1;
        crashController.abort(simulatedCrash);
        throw simulatedCrash;
      },
    });
    await expect(firstAgent.run({
      turn,
      signal: crashController.signal,
    })).rejects.toBe(simulatedCrash);
    expect(initialProviderCalls).toBe(3);
    expect(correctionRequests).toBe(1);
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 0,
    });

    fixture.stores.close();
    initialClosed = true;
    reopened = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId: "guided-closeout-crash-reopened",
      storageProfile: "ephemeral",
    });
    reopened.guidedToolJournal.start({
      turnId,
      callId: "crash-recovery-late-result",
      toolName: "read_file",
      rawArguments: stableJson({ path: "late.txt" }),
      arguments: { path: "late.txt" },
    });
    reopened.guidedToolJournal.finish({
      callId: "crash-recovery-late-result",
      status: "completed",
      result: { ok: true, content: "late result" },
    });
    const withLateResult = await reopened.durableWork.attachToolResult({
      turnId,
      sessionId: "guided-local-session",
      mutationCallId: "attach-crash-recovery-late-result",
      toolCallId: "crash-recovery-late-result",
    });
    expect(reopened.guidedEffectJournal.prepare({
      effectId: "crash-recovery-late-effect",
      receiptId: "crash-recovery-late-effect-receipt",
      idempotencyKey: "crash-recovery-late-effect-key",
      identitySha256: "d".repeat(64),
      requestSha256: "e".repeat(64),
      inputSha256: "f".repeat(64),
      targetSha256: "0".repeat(64),
      workId: withLateResult.workId,
      planRevisionId: withLateResult.currentPlan!.planRevisionId,
      actionKey: "finish",
      capability: "write_file",
      sanitizedTarget: "workspace:late.txt",
    })).toMatchObject({ ok: true, created: true });
    let recoveredProviderCalls = 0;
    const recoveredAgent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: reopened.contextDocuments,
      toolJournal: reopened.guidedToolJournal,
      operationResultReader: reopened.guidedOperationResultReader,
      effectJournal: reopened.guidedEffectJournal,
      durableWork: reopened.durableWork,
      modelRound: {
        async runRound() {
          recoveredProviderCalls += 1;
          return { text: "재시작 후 후보", toolCalls: [] };
        },
      },
    });
    await expect(recoveredAgent.run({
      turn,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      content: [
        "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
        "재시작 후 후보",
      ].join("\n\n"),
    });
    expect(recoveredProviderCalls).toBe(1);
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
    await expect(recoveredAgent.run({
      turn,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      content: [
        "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
        "재시작 후 후보",
      ].join("\n\n"),
    });
    expect(recoveredProviderCalls).toBe(2);
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
  } finally {
    reopened?.close();
    if (!initialClosed) fixture.stores.close();
    rmSync(fixture.root, { recursive: true, force: true });
    restoreEnv("BUTLER_PHASE_TOOL_SURFACE", previousSurface);
  }
});

test("runtime-owned open notice survives a crash before final Turn delivery", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-closeout-final-commit-crash");
  const turnId = "guided-closeout-final-commit-crash-turn";
  let reopened: ReturnType<typeof openBtccSqliteStores> | undefined;
  let initialClosed = false;
  try {
    let initialProviderCalls = 0;
    const firstAgent = fixture.agent({
      async runRound() {
        initialProviderCalls += 1;
        if (initialProviderCalls === 1) {
          return toolResponse([toolCall("final-crash-plan", "replace_work_plan", {
            start_new: true,
            objective: "Work 정산 뒤 Turn 저장 실패에서 안내를 복구한다",
            actions: [{ action_key: "finish", dependency_keys: [] }],
            checks: [],
          })]);
        }
        if (initialProviderCalls === 2) {
          return { text: "첫 종료 후보", toolCalls: [] };
        }
        return { text: "정산된 종료 후보", toolCalls: [] };
      },
    });
    const simulatedCrash = new Error("simulated crash before final Turn commit");
    let finalCommitAttempts = 0;
    const firstRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: overrideTurnCommit(
        fixture.stores.turns,
        async (input) => {
          if (input.transition.kind === "accept_guided_final") {
            finalCommitAttempts += 1;
            throw simulatedCrash;
          }
          return fixture.stores.turns.commitTransition(input);
        },
      ),
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: firstAgent,
    });

    await expect(firstRuntime.runTurn(localRunCommand(fixture.root, turnId)))
      .rejects.toBe(simulatedCrash);
    expect(initialProviderCalls).toBe(3);
    expect(finalCommitAttempts).toBe(1);
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
    await expect(fixture.stores.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({
        status: "open",
        latestDisposition: {
          disposition: "open",
          originTurnId: turnId,
          runtimeOwnedOpen: true,
        },
      });
    const beforeRestart = await fixture.stores.turns.findTurn(turnId);
    expect(beforeRestart).toMatchObject({
      semanticState: "admitted",
    });
    const beforeRestartDb = new Database(fixture.dbPath);
    try {
      expect(beforeRestartDb.query<{
        final_payload_json: string | null;
        delivery_outbox_id: string | null;
      }, [string]>(`
        SELECT final_payload_json, delivery_outbox_id FROM btcc_turns
        WHERE turn_id = ?
      `).get(turnId)).toEqual({
        final_payload_json: null,
        delivery_outbox_id: null,
      });
    } finally {
      beforeRestartDb.close(false);
    }

    fixture.stores.close();
    initialClosed = true;
    reopened = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId: "guided-closeout-final-commit-reopened",
      storageProfile: "ephemeral",
    });
    let recoveredProviderCalls = 0;
    const recoveredAgent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: reopened.contextDocuments,
      toolJournal: reopened.guidedToolJournal,
      operationResultReader: reopened.guidedOperationResultReader,
      effectJournal: reopened.guidedEffectJournal,
      durableWork: reopened.durableWork,
      modelRound: {
        async runRound() {
          recoveredProviderCalls += 1;
          return { text: "재시작 뒤 전달 후보", toolCalls: [] };
        },
      },
    });
    const recoveredRuntime = createGuidedTurnRuntime({
      admission: reopened.admission,
      turns: reopened.turns,
      messages: reopened.messages,
      committedSuccessorReadiness: reopened.committedSuccessorReadiness,
      agent: recoveredAgent,
    });

    await expect(recoveredRuntime.runTurn(localRunCommand(fixture.root, turnId)))
      .resolves.toMatchObject({
        kind: "delivered",
        content: [
          "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
          "재시작 뒤 전달 후보",
        ].join("\n\n"),
      });
    expect(recoveredProviderCalls).toBe(1);
    expect(closeoutRowCounts(fixture.dbPath, turnId)).toEqual({
      diagnostics: 1,
      dispositions: 1,
    });
    const db = new Database(fixture.dbPath);
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_messages
        WHERE turn_id = ? AND role = 'assistant'
      `).get(turnId)?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_delivery_outbox WHERE turn_id = ?
      `).get(turnId)?.count).toBe(1);
    } finally {
      db.close(false);
    }
  } finally {
    reopened?.close();
    if (!initialClosed) fixture.stores.close();
    rmSync(fixture.root, { recursive: true, force: true });
    restoreEnv("BUTLER_PHASE_TOOL_SURFACE", previousSurface);
  }
});

test("HTML Work completes without a built-in browser preview requirement", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-html-completion-without-preview");
  try {
    const workspace = join(fixture.root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const turnId = "guided-html-completion-without-preview-turn";
    let calls = 0;
    let rejected: unknown;
    const agent = fixture.agent({
      async runRound(request) {
        calls += 1;
        if (calls === 1) return toolResponse([toolCall("page-plan", "replace_work_plan", {
          start_new: true,
          objective: "페이지를 만들고 확인한다",
          actions: [{ action_key: "page", dependency_keys: [] }],
          checks: [],
        })]);
        if (calls === 2) {
          writeFileSync(join(workspace, "index.html"), "<main>ready</main>");
          await addAttachedFileResult(fixture, {
            turnId,
            callId: "page-write",
            toolName: "write_file",
          });
          const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          return toolResponse([toolCall("page-completed", "record_work_disposition", {
            work_id: bound!.workId,
            disposition: "completed",
            summary: "페이지를 완료했습니다.",
            action_updates: [{ action_key: "page", status: "done" }],
          })]);
        }
        if (calls === 3) {
          rejected = toolMessageOutput(messagesWithToolResults(request).find(
            (message) => message.name === "record_work_disposition",
          ));
          return { text: "페이지 작업 결과", toolCalls: [] };
        }
        return { text: "페이지 작업 결과", toolCalls: [] };
      },
    });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });

    const outcome = await runtime.runTurn(localRunCommand(workspace, turnId));
    expect(outcome).toMatchObject({ kind: "delivered", content: "페이지 작업 결과" });
    expect(rejected).toMatchObject({
      ok: true,
      work: { status: "completed" },
    });
    await expect(fixture.stores.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({ status: "completed", latestDisposition: { disposition: "completed" } });
    const db = new Database(fixture.dbPath);
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions
        WHERE disposition = 'completed'
      `).get()?.count).toBe(1);
    } finally {
      db.close(false);
    }
  } finally {
    fixture.close();
    restoreEnv("BUTLER_PHASE_TOOL_SURFACE", previousSurface);
  }
});

test("production Guided Turn sends the admitted feature direct surface and stable prefix", async () => {
  const fixture = createFixture("guided-feature-direct-surface");
  const previousFlag = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  try {
    let captured: ModelRoundRequest | undefined;
    const agent = fixture.agent({
      async runRound(request) {
        captured = request;
        return { text: "direct answer", toolCalls: [] };
      },
    });
    const result = await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-feature-direct-surface",
        accessMode: "read_only",
        trackingMode: "none",
      }),
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("direct answer");
    expect(captured?.tools.map((tool) => tool.name)).toContain("web_search");
    expect(captured?.tools.map((tool) => tool.name)).toContain("recall_memory");
    expect(captured?.tools.map((tool) => tool.name)).not.toContain("read_file");
    expect(captured?.tools.map((tool) => tool.name)).not.toContain("replace_work_plan");
    expect(captured?.instructions).toContain("This is a direct non-project phase");
    expect(captured?.instructions).not.toContain("The Work stage is process guidance");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("production Guided Turn exposes and executes exact result reads only through selected phase capability", async () => {
  const fixture = createFixture("guided-feature-exact-read");
  const previousFlag = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  const turnId = "guided-feature-exact-read";
  try {
    fixture.stores.guidedToolJournal.start({
      turnId, callId: "durable-result", toolName: "read_file",
      rawArguments: "{}", arguments: {},
    });
    fixture.stores.guidedToolJournal.finish({
      callId: "durable-result", status: "completed",
      result: { ok: true, content: "exact durable content" },
    });
    const stored = fixture.stores.guidedToolJournal.findForTurn(turnId, "durable-result")!;
    const requests: ModelRoundRequest[] = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        requests.push(request);
        expect(request.tools.map((tool) => tool.name)).toContain("read_operation_results");
        return toolResponse([toolCall("exact-read", "read_operation_results", {
          result_ref: "durable-result", sha256: stored.resultSha256, revision: null,
          work_id: null, offset: 0, length: 32,
        })]);
      },
      (request) => {
        requests.push(request);
        expect(JSON.stringify(messagesWithToolResults(request))).toContain("base64");
        return { text: "exact result verified", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, {
        turnId, accessMode: "read_only", trackingMode: "none",
      });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await agent.run({
      turn,
      signal: new AbortController().signal,
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });
    expect(result.content).toBe("exact result verified");
    expect(requests).toHaveLength(2);
  } finally {
    if (previousFlag === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previousFlag;
    fixture.close();
  }
});

test("enabled exact replay fails before provider dispatch without durable route acceptance ports", async () => {
  const fixture = createFixture("guided-exact-replay-preflight");
  const previousFlag = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  let calls = 0;
  try {
    const agent = fixture.agent({ async runRound() {
      calls += 1;
      return { text: "must not dispatch", toolCalls: [] };
    } });
    await expect(agent.run({
      turn: turnRecord(fixture.root), signal: new AbortController().signal,
    })).rejects.toThrow("operation_result_route_acceptance_dependency_missing");
    expect(calls).toBe(0);
  } finally {
    if (previousFlag === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previousFlag;
    fixture.close();
  }
});

test("production Turn resolves a Work created after replay runtime construction", async () => {
  const fixture = createFixture("guided-dynamic-work-exact-read");
  const previousReplay = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  writeFileSync(join(fixture.root, "large.txt"), "W".repeat(12_000));
  writeFileSync(join(fixture.root, "small.txt"), "small");
  try {
    let reference: Record<string, unknown> | undefined;
    let rounds = 0;
    const agent = fixture.agent(scriptedModelRound([
      () => { rounds += 1; return toolResponse([toolCall("plan", "replace_work_plan", {
        objective: "Read one durable large result",
        actions: [{ action_key: "read", description: "Read the large file" }],
        checks: ["The exact range is available"],
      })]); },
      () => { rounds += 1; return toolResponse([toolCall("large", "read_file", { requests: [{ path: "large.txt" }] })]); },
      () => { rounds += 1; return toolResponse([toolCall("small", "read_file", { requests: [{ path: "small.txt" }] })]); },
      (request) => {
        rounds += 1;
        const referenceMessage = messagesWithToolResults(request)
          .find((message) => message.name === "read_file" &&
            message.content.includes("butler.operation-result-reference.v1"));
        expect(referenceMessage).toBeDefined();
        reference = JSON.parse(referenceMessage!.content) as Record<string, unknown>;
        const identity = reference.identity as Record<string, unknown>;
        const integrity = reference.integrity as Record<string, unknown>;
        expect(identity.kind).toBe("work");
        expect(identity.work_id).toBeString();
        return toolResponse([toolCall("exact", "read_operation_results", {
          result_ref: identity.result_ref, sha256: integrity.sha256,
          revision: integrity.revision, work_id: identity.work_id,
          offset: 0, length: 64,
        })]);
      },
      async (request) => {
        rounds += 1;
        const exact = messagesWithToolResults(request).find((message) => message.name === "read_operation_results");
        expect(JSON.parse(exact!.content)).toMatchObject({
          ok: true, output: { encoding: "base64", offset: 0, length: 64 },
        });
        const bound = await fixture.stores.durableWork.boundWorkForTurn(
          "dynamic-work-turn",
        );
        return toolResponse([toolCall("dynamic-work-disposition", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "completed",
          summary: "The exact range is available.",
          action_updates: [{ action_key: "read", status: "done" }],
        })]);
      },
      () => {
        rounds += 1;
        return { text: "dynamic Work exact range verified", toolCalls: [] };
      },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    const command = localRunCommand(fixture.root, "dynamic-work-turn");
    command.modelSelection.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await runtime.runTurn(command);
    expect(rounds).toBe(6);
    expect(reference).toBeDefined();
    expect(result).toMatchObject({
      kind: "delivered", content: "dynamic Work exact range verified",
    });
  } finally {
    if (previousReplay === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previousReplay;
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("production Guided Turn projects economical results through the actual Codex serializer", async () => {
  const fixture = createFixture("guided-feature-codex-exact-replay");
  const previousFlag = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  const previousBase = process.env.BUTLER_CODEX_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  process.env.BUTLER_CODEX_BASE_URL = "https://example.test/backend-api";
  writeFileSync(join(fixture.root, "large.txt"), "L".repeat(2_700));
  writeFileSync(join(fixture.root, "small.txt"), "small evidence");
  bindAppProject(fixture.dbPath, {
    id: "guided-agent-session", workspacePath: fixture.root,
    ledgerProjectId: "guided-feature-codex-exact-replay",
  });
  const requestBodies: Record<string, unknown>[] = [];
  let responseIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
    responseIndex += 1;
    const items = responseIndex === 1
      ? [{ type: "function_call", call_id: "large-read", name: "read_file", arguments: JSON.stringify({ requests: [{ path: "large.txt" }] }) }]
      : responseIndex === 2
        ? [{ type: "function_call", call_id: "small-read", name: "read_file", arguments: JSON.stringify({ requests: [{ path: "small.txt" }] }) }]
        : [{ type: "message", content: [{ type: "output_text", text: "serializer verified" }] }];
    const output = items.map((item) =>
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    ).join("");
    const completed = { type: "response.completed", response: {
      id: `response-${responseIndex}`, status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 } },
    } };
    return new Response(`${output}data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  try {
    const authorization = `Bearer e30.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account" },
    })).toString("base64url")}.signature`;
    const agent = fixture.agent({
      async runRound(request) {
        const result = await runOpenAIModelRound(
          request, { authorization, mode: "codex_oauth" }, "openai/gpt-5.6-sol",
        );
        return result;
      },
    });
    const turn = turnRecord(fixture.root, {
        turnId: "guided-feature-codex-exact-replay",
        accessMode: "read_only", trackingMode: "none",
        projectId: "guided-feature-codex-exact-replay",
      });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await agent.run({
      turn,
      signal: AbortSignal.timeout(20_000),
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });
    expect(result.content).toBe("serializer verified");
    expect(requestBodies).toHaveLength(3);
    const second = JSON.stringify(requestBodies[1]);
    const third = JSON.stringify(requestBodies[2]);
    expect(second).toContain("L".repeat(1024));
    expect(third).not.toContain("L".repeat(1024));
    expect(third).toContain("butler.operation-result-reference.v1");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousFlag === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previousFlag;
    if (previousBase === undefined) delete process.env.BUTLER_CODEX_BASE_URL;
    else process.env.BUTLER_CODEX_BASE_URL = previousBase;
    fixture.close();
  }
}, 30_000);

test("production Guided Turn preserves official Responses continuation for economical replay", async () => {
  const fixture = createFixture("guided-feature-official-exact-replay");
  const previousFlag = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  const previousBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  writeFileSync(join(fixture.root, "official-large.txt"), "O".repeat(2_700));
  writeFileSync(join(fixture.root, "official-small.txt"), "small");
  const bodies: Record<string, unknown>[] = [];
  const responses = [
    { id: "official-1", model: "gpt-5.6-sol", output: [{
      type: "function_call", call_id: "official-large", name: "read_file",
      arguments: JSON.stringify({ requests: [{ path: "official-large.txt" }] }),
    }] },
    { id: "official-2", model: "gpt-5.6-sol", output: [{
      type: "function_call", call_id: "official-small", name: "read_file",
      arguments: JSON.stringify({ requests: [{ path: "official-small.txt" }] }),
    }] },
    { id: "official-3", model: "gpt-5.6-sol", output: [{
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "official serializer verified" }],
    }] },
  ];
  let responseIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json(responses[responseIndex++]!);
  }) as typeof fetch;
  try {
    const agent = fixture.agent({ runRound: (request) => runOpenAIModelRound(
      request, { authorization: "Bearer test-key", mode: "api_key" },
      "openai/gpt-5.6-sol",
    ) });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-official-exact", accessMode: "read_only", trackingMode: "none",
    });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await agent.run({
      turn, signal: new AbortController().signal,
      loadModelRoundAcceptance: async () => undefined,
      recordModelRoundAcceptance: async () => {},
    });
    expect(result.content).toBe("official serializer verified");
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[1])).toContain("O".repeat(1024));
    expect(bodies[1]?.previous_response_id).toBe("official-1");
    expect(JSON.stringify(bodies[2])).not.toContain("O".repeat(1024));
    expect(JSON.stringify(bodies[2])).not.toContain("butler.operation-result-reference.v1");
    expect(bodies[2]?.previous_response_id).toBe("official-2");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousFlag === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previousFlag;
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    fixture.close();
  }
}, 30_000);

test("production feature read-only surface executes an admitted native registry tool", async () => {
  const fixture = createFixture("guided-feature-read-only-native");
  const previousFlag = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  writeFileSync(join(fixture.root, "evidence.txt"), "native evidence\n");
  bindAppProject(fixture.dbPath, {
    id: "guided-agent-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-feature-read-only",
  });
  try {
    const requests: ModelRoundRequest[] = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        requests.push(request);
        return toolResponse([toolCall("read-evidence", "read_file", {
          requests: [{ path: "evidence.txt" }],
        })]);
      },
      (request) => {
        requests.push(request);
        expect(JSON.stringify(messagesWithToolResults(request)))
          .toContain("native evidence");
        return { text: "read-only evidence accepted", toolCalls: [] };
      },
    ]));
    const result = await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-feature-read-only-native",
        accessMode: "read_only",
        trackingMode: "none",
        projectId: "guided-feature-read-only",
      }),
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("read-only evidence accepted");
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("read_file");
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("run_command");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("production feature execution instructions preserve guarded effects and atomic Work closeout", async () => {
  const fixture = createFixture("guided-feature-execution-instructions");
  const previousFlag = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  bindAppProject(fixture.dbPath, {
    id: "guided-agent-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-feature-execution",
  });
  try {
    let captured: ModelRoundRequest | undefined;
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        captured = request;
        return toolResponse([toolCall("lifecycle-search", "tool_search", {
          query: "project_ledger_work_complete",
          include_disabled: true,
        })]);
      },
      { text: "execution instructions accepted", toolCalls: [] },
    ]));
    await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-feature-execution-instructions",
        accessMode: "full_access",
        trackingMode: "ledger",
        projectId: "guided-feature-execution",
      }),
      signal: new AbortController().signal,
    });

    expect(captured?.instructions).toContain("create or reuse one Work");
    expect(captured?.instructions).toContain("execute effects through the existing guard");
    expect(captured?.instructions).toContain("inspect the actual result");
    expect(captured?.instructions).toContain("record_work_disposition");
    expect(captured?.instructions).toContain("optional quality records");
    expect(captured?.instructions).not.toContain("required accepted Plan Review");
    expect(captured?.instructions).toContain("admitted native tools");
    expect(captured?.tools.map((tool) => tool.name)).toContain("replace_work_plan");
    expect(captured?.tools.map((tool) => tool.name)).not.toContain("record_work_disposition");
    expect(captured?.tools.map((tool) => tool.name)).toContain("run_command");
    expect(captured?.tools.map((tool) => tool.name))
      .not.toContain("project_ledger_work_complete");
    expect(JSON.stringify(fixture.stores.guidedToolJournal.list(
      "guided-feature-execution-instructions",
    ))).toContain("native:project_ledger_work_complete");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("production Guided Turn rereads Work across execution windows in one agent run", async () => {
  const fixture = createFixture("guided-production-window-continuation");
  try {
    const requests: ModelRoundRequest[] = [];
    let modelCalls = 0;
    let loadContextCalls = 0;
    let boundWorkCalls = 0;
    const durableWork = fixture.stores.durableWork;
    const trackedDurableWork = {
      ...durableWork,
      async loadContext(scope: Parameters<typeof durableWork.loadContext>[0]) {
        loadContextCalls += 1;
        return durableWork.loadContext(scope);
      },
      async boundWorkForTurn(turnId: string) {
        boundWorkCalls += 1;
        return durableWork.boundWorkForTurn(turnId);
      },
    };
    const modelRound: ModelRoundPort = {
      async runRound(request) {
        requests.push(request);
        modelCalls += 1;
        if (modelCalls === 1) {
          return toolResponse([toolCall("window-plan", "replace_work_plan", {
            start_new: true,
            objective: "Preserve evidence across the execution windows.",
            actions: [{
              action_key: "preserve-evidence",
              description: "Keep the collected evidence available for the final answer.",
            }],
            checks: ["The final answer uses the collected evidence."],
          })]);
        }
        if (modelCalls === 2) {
          return toolResponse([toolCall("window-checkpoint", "record_work_checkpoint", {
            action_updates: [{
              action_key: "preserve-evidence",
              status: "active",
            }],
            public_summary: "The collected evidence remains available.",
            next_step: "Use the evidence in the final answer.",
          })]);
        }
        if (modelCalls === 3) {
          const bound = await durableWork.boundWorkForTurn(
            "guided-production-window-turn",
          );
          return toolResponse([toolCall("window-disposition", "record_work_disposition", {
            work_id: bound!.workId,
            disposition: "open",
            summary: "수집한 근거를 유지하며 답변을 준비합니다.",
            remaining_actions: ["최종 답변을 전달한다"],
          })]);
        }
        return { text: "확인된 근거를 바탕으로 답변을 완료했습니다.", toolCalls: [] };
      },
    };
    const agent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      effectJournal: fixture.stores.guidedEffectJournal,
      durableWork: trackedDurableWork,
      modelRound,
      executionWindowSize: 1,
    });
    const turnId = "guided-production-window-turn";
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    const result = await runtime.runTurn(localRunCommand(fixture.root, turnId));
    expect(result).toMatchObject({
      kind: "delivered",
      content: "확인된 근거를 바탕으로 답변을 완료했습니다.",
    });
    await expect(fixture.stores.durableWork.boundWorkForTurn(turnId)).resolves
      .toMatchObject({ status: "open", latestDisposition: { disposition: "open" } });
    expect(modelCalls).toBe(4);
    expect(loadContextCalls).toBeGreaterThanOrEqual(4);
    expect(boundWorkCalls).toBeGreaterThanOrEqual(4);
    expect(requests).toHaveLength(4);
    expect(requests[0]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(1);
    expect(requests[1]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(2);
    expect(requests[2]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(3);
    expect(requests[1]?.messages.at(-1)?.content).toContain("Execution checkpoint 1");
    expect(requests[1]?.messages.at(-1)?.content).toContain("Durable Work status");
    expect(requests[2]?.messages.at(-1)?.content).toContain("Execution checkpoint 2");
    expect(requests[2]?.messages.at(-1)?.content)
      .toContain("The collected evidence remains available.");
    expect(requests[3]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(4);
  } finally {
    fixture.close();
  }
});

test("Guided fallback projects the cursor model into public iteration and fallback evidence", async () => {
  const fixture = createFixture("guided-model-route-projection");
  try {
    const requests: string[] = [];
    const iterationModels: string[] = [];
    const fallbackModels: string[] = [];
    const fallbackActivities: Array<{
      originTurnId?: string;
      sourceRevision?: number;
      summary: string;
    }> = [];
    const agent = fixture.agent({
      async runRound(request) {
        requests.push(String(request.model));
        if (request.model === "openai/gpt-5.5") {
          throw new ModelProviderRequestError({
            code: "provider_rate_limited",
            message: "rate limited",
            provider: "openai",
            retryable: true,
          });
        }
        if (requests.filter((model) => model === "zai/glm-5.2").length === 1) {
          return {
            toolCalls: [toolCall("capabilities-1", "list_tool_capabilities", {})],
          };
        }
        return { text: "backup answer", toolCalls: [] };
      },
    });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-model-route-projection",
    });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.5",
      backupModelRefs: ["zai/glm-5.2"],
      reasoningEffort: "medium",
      retryCeiling: 1,
    });
    await agent.run({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged() {},
        modelRoundWaitingChanged(update) {
          if (update.status === "started" && update.modelRef) {
            iterationModels.push(update.modelRef);
          }
        },
        phaseActivityChanged(update) {
          if (update.modelRef) fallbackModels.push(update.modelRef);
          if (update.modelRef) fallbackActivities.push(update);
        },
      },
    });

    expect(requests).toEqual([
      "openai/gpt-5.5",
      "zai/glm-5.2",
      "zai/glm-5.2",
    ]);
    expect(iterationModels).toEqual([
      "openai/gpt-5.5",
      "zai/glm-5.2",
      "zai/glm-5.2",
    ]);
    expect(fallbackModels).toEqual(["zai/glm-5.2"]);
    expect(fallbackActivities).toEqual([expect.objectContaining({
      originTurnId: "guided-model-route-projection",
      sourceRevision: expect.any(Number),
      summary: "대체 모델 경로로 계속 진행합니다.",
    })]);
  } finally {
    fixture.close();
  }
});

test("unbound ordinary activity survives failure without stale Work progress", async () => {
  const fixture = createFixture("guided-unbound-ordinary-progress");
  try {
    writeFileSync(join(fixture.root, "ordinary.txt"), "ordinary evidence\n");
    const turnId = "guided-unbound-ordinary-progress";
    const activities: Array<{
      originTurnId?: string;
      sourceRevision?: number;
      summary: string;
    }> = [];
    let calls = 0;
    const agent = fixture.agent({
      async runRound() {
        calls += 1;
        if (calls === 1) {
          return toolResponse([
            toolCall("unbound-review", "record_work_review", {
              subject: "result",
              verdict: "partial",
              summary: "관계 없는 검토 요청",
              corrections: [],
            }),
            toolCall("unbound-read", "read_file", {
              requests: [{ path: "ordinary.txt" }],
            }),
          ]);
        }
        throw knownProviderFailure("unbound ordinary provider disconnected");
      },
    });
    const outcome = await agent.run({
      turn: turnRecord(fixture.root, { turnId, trackingMode: "local" }),
      signal: new AbortController().signal,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          activities.push(update);
        },
      },
    });
    expect(calls).toBe(2);
    expect(outcome.content).toContain("현재 진행 내용: 읽기: ordinary.txt 작업을 진행하고 있습니다.");
    expect(outcome.content).not.toContain("관계 없는 검토 요청");
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originTurnId: turnId,
        sourceRevision: expect.any(Number),
        summary: "읽기: ordinary.txt 작업을 진행하고 있습니다.",
      }),
    ]));
    expect(await fixture.stores.durableWork.boundWorkForTurn(turnId)).toBeNull();
  } finally {
    fixture.close();
  }
});

test("primary-only route uses the durable routed path", async () => {
  const fixture = createFixture("guided-primary-only-route");
  try {
    let routeEvents = 0;
    let acceptedResponses = 0;
    let attemptHistoryLoads = 0;
    const agent = fixture.agent({
      async runRound() {
        return {
          text: "primary answer",
          toolCalls: [],
          providerIdentity: {
            provider: "openai",
            configuredModel: "openai/gpt-5.5",
            reportedModel: "gpt-5.5-served",
          },
        };
      },
    });
    const turn = turnRecord(fixture.root, { turnId: "guided-primary-only-route" });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.5",
      reasoningEffort: "medium",
      retryCeiling: 3,
    });
    const result = await agent.run({
      turn,
      signal: new AbortController().signal,
      recordModelRouteEvent: async () => {
        routeEvents += 1;
      },
      loadModelRouteAttemptHistory: async () => {
        attemptHistoryLoads += 1;
        return { started: [], failed: [], succeeded: [], abandoned: [] };
      },
      loadModelRoundAcceptance: async () => undefined,
      recordModelRoundAcceptance: async () => {
        acceptedResponses += 1;
      },
    });

    expect(routeEvents).toBe(1);
    expect(acceptedResponses).toBe(1);
    expect(attemptHistoryLoads).toBe(1);
    expect(result.modelIdentity).toEqual({
      requestedModelRef: "openai/gpt-5.6-sol",
      effectiveModelRef: "openai/gpt-5.5",
      providerReportedModelRef: "openai/gpt-5.5-served",
    });
  } finally {
    fixture.close();
  }
});

test("production Turn rejects a persisted accepted response without its round tool surface", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-persisted-tool-surface-mismatch");
  try {
    const turnId = "guided-persisted-tool-surface-mismatch";
    const command = localRunCommand(fixture.root, turnId);
    command.modelSelection.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
      retryCeiling: 2,
      catalogGeneration: "persisted-tool-surface-mismatch",
    });
    const seedRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: {
        async run({ recordModelRoundAcceptance }) {
          await recordModelRoundAcceptance?.({
            roundId: "btcc-model-round-0",
            candidateIndex: 0,
            transportAttempt: 1,
            modelRef: "openai/gpt-5.6-sol",
            result: {
              text: "stale accepted response",
              toolCalls: [],
              continuation: {
                provider: "openai",
                responseId: "stale-accepted-response",
                deliveredThroughOrdinal: 1,
              },
            },
          });
          throw new ModelRouteDurabilityError(
            "attempt_event_write",
            new Error("preserve active checkpoint"),
          );
        },
      },
    });
    await expect(seedRuntime.runTurn(command)).rejects
      .toBeInstanceOf(ModelRouteDurabilityError);

    let providerCalls = 0;
    const productionRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: fixture.agent({
        async runRound() {
          providerCalls += 1;
          return { text: "unexpected provider response", toolCalls: [] };
        },
      }),
    });
    await expect(productionRuntime.runTurn(command)).rejects.toMatchObject({
      name: "RoundToolSurfaceError",
      code: "round_tool_surface_continuation_invalid",
    });
    expect(providerCalls).toBe(0);
    expect(fixture.stores.guidedToolJournal.list(turnId)).toEqual([]);
    const persistedTurn = await fixture.stores.turns.findTurn(turnId);
    expect(persistedTurn?.semanticState).toBe("admitted");
    expect(persistedTurn?.finalPayload).toBeUndefined();
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_messages
        WHERE turn_id = ? AND role = 'assistant'
      `).get(turnId)?.count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("Guided model rounds attribute provider usage before completion progress", async () => {
  const fixture = createFixture("guided-usage-attribution");
  try {
    const events: string[] = [];
    const turnId = "guided-usage-attribution";
    const agent = fixture.agent({
      async runRound(request) {
        events.push(`metric:${request.usageAttribution?.turnId ?? "missing"}`);
        return { text: "BTCC final answer", toolCalls: [] };
      },
    });

    await agent.run({
      turn: turnRecord(fixture.root, { turnId }),
      signal: new AbortController().signal,
      progress: {
        stateChanged() {},
        modelRoundWaitingChanged(update) {
          events.push(update.status);
        },
      },
    });

    expect(events).toEqual(["started", `metric:${turnId}`, "completed"]);
  } finally {
    fixture.close();
  }
});

test("Guided Turn promotes persona and profile context into every provider instruction", async () => {
  const fixture = createFixture("guided-persona-instructions");
  try {
    const personaRef = fixture.stores.contextDocuments.persist({
      scopeKind: "user",
      scopeId: "local-user",
      projectionClass: "profile",
      sourceId: "active-persona-reminder",
      sourceRevision: "persona-v1",
      content: "## Active Persona Reminder\n\n말끝에 반드시 냥을 붙인다.",
    });
    const profileRef = fixture.stores.contextDocuments.persist({
      scopeKind: "user",
      scopeId: "local-user",
      projectionClass: "profile",
      sourceId: "personalization-profile",
      sourceRevision: "profile-v1",
      content: "## Personalization Profile\n\nPreferred address: 사용자님",
    });
    const runtimeRef = fixture.stores.contextDocuments.persist({
      scopeKind: "session",
      scopeId: "guided-persona-instructions",
      projectionClass: "optional_hot_cache",
      sourceId: "runtime-state",
      sourceRevision: "runtime-v1",
      content: "## Turn Environment\nAssistant Response Language: Korean",
    });
    const instructions: Array<string | undefined> = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        instructions.push(request.instructions);
        return toolResponse([toolCall("read-1", "read_file", { requests: [{ path: "README.md" }] })]);
      },
      (request) => {
        instructions.push(request.instructions);
        return { text: "확인했냥.", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, { turnId: "guided-persona-instructions" });
    turn.context.profileRefs = [personaRef, profileRef];
    turn.context.optionalHotCacheRefs = [runtimeRef];

    await agent.run({ turn, signal: new AbortController().signal });

    expect(instructions).toHaveLength(2);
    for (const value of instructions) {
      expect(value).toContain("Active Persona Reminder");
      expect(value).toContain("말끝에 반드시 냥을 붙인다.");
      expect(value).toContain("Preferred address: 사용자님");
      expect(value).toContain("Use Korean for every user-facing message");
    }
  } finally {
    fixture.close();
  }
});

test("Guided agent leaves web query planning to the selected model", async () => {
  const fixture = createFixture("guided-model-owned-search");
  try {
    writeFileSync(join(fixture.root, "butler.config.json"), JSON.stringify({
      webSearch: { provider: "mock" },
    }));
    const turnId = "guided-model-owned-search";
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("search-1", "web_search", {
        query: "Butler guided search ownership",
      })]),
      { text: "검색했습니다.", toolCalls: [] },
    ]));

    await agent.run({
      turn: turnRecord(fixture.root, { turnId }),
      signal: new AbortController().signal,
    });
    const searchResult = fixture.stores.guidedToolJournal.list(turnId)[0]?.result as
      Record<string, any> | undefined;

    expect(searchResult?.search_plan).toMatchObject({
      mode: "direct",
      planner_used: false,
      planner_attempts: 0,
      original_query: "Butler guided search ownership",
    });
    expect(searchResult?.search_plan?.fallback_reason).toBe(
      "guided model owns search planning",
    );
  } finally {
    fixture.close();
  }
});

test("Guided agent exposes only typed Project Ledger effects in a writable project turn", async () => {
  const fixture = createFixture("guided-policy");
  try {
    const availability = async (turn: TurnRecord, query = "project_ledger_create") => {
      const agent = fixture.agent(scriptedModelRound([
        toolResponse([toolCall("search-1", "tool_search", {
          query,
          include_disabled: true,
        })]),
        { text: "확인했습니다.", toolCalls: [] },
      ]));
      await agent.run({ turn, signal: new AbortController().signal });
      const result = fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result;
      const results = (result as { results?: Array<{ id: string; enabled: boolean }> }).results ?? [];
      return results.find((entry) => entry.id === `native:${query}`)?.enabled;
    };

    const descriptionTurnId = "turn-project-description";
    const descriptionAgent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("describe-1", "tool_describe", {
        ids: ["native:project_ledger_update"],
      })]),
      { text: "확인했습니다.", toolCalls: [] },
    ]));

    const fullAccessProjectTurn = turnRecord(fixture.root, {
      accessMode: "full_access",
      trackingMode: "ledger",
      projectId: "project-1",
    });
    expect(await availability(fullAccessProjectTurn)).toBe(true);
    await descriptionAgent.run({
      turn: {
        ...fullAccessProjectTurn,
        turnId: descriptionTurnId,
        inboxId: "inbox:turn-project-description",
        triggerKey: "trigger:turn-project-description",
        originalMessageId: "message:turn-project-description",
      },
      signal: new AbortController().signal,
    });
    const updateDescription = fixture.stores.guidedToolJournal.list(descriptionTurnId)[0]?.result;
    expect(JSON.stringify(updateDescription)).toContain('"required":["kind","id"]');
    expect(await availability(fullAccessProjectTurn, "render_project_dashboard"))
      .toBeUndefined();
    expect(await availability(fullAccessProjectTurn, "complete_project_work"))
      .toBeUndefined();
    expect(await availability(turnRecord(fixture.root, {
      accessMode: "read_only",
      trackingMode: "ledger",
      projectId: "project-1",
      turnId: "turn-read-only",
    }))).toBeUndefined();

    let visibleNames: string[] = [];
    let writeFileSchema = "";
    let editFileSchema = "";
    let instructions = "";
    const projectAgent = fixture.agent({
      async runRound(request) {
        visibleNames = request.tools.map((tool) => tool.name);
        writeFileSchema = JSON.stringify(
          request.tools.find((tool) => tool.name === "write_file")?.parameters,
        );
        editFileSchema = JSON.stringify(
          request.tools.find((tool) => tool.name === "edit_file")?.parameters,
        );
        instructions = request.instructions ?? "";
        return { text: "준비했습니다.", toolCalls: [] };
      },
    });
    await projectAgent.run({
      turn: turnRecord(fixture.root, {
        accessMode: "full_access",
        trackingMode: "ledger",
        projectId: "project-visible",
        turnId: "turn-project-visible",
      }),
      signal: new AbortController().signal,
    });
    expect(visibleNames).toContain("write_file");
    expect(visibleNames).toContain("edit_file");
    expect(writeFileSchema).not.toContain("expected_sha256");
    expect(writeFileSchema).not.toContain("overwrite");
    expect(writeFileSchema).toContain("create_parents");
    expect(editFileSchema).not.toContain("expected_sha256");
    expect(visibleNames).toContain("project_ledger_status");
    expect(visibleNames).toContain("project_ledger_list");
    expect(visibleNames).not.toContain("project_ledger_show");
    expect(visibleNames).toContain("project_ledger_create");
    expect(visibleNames).not.toContain("project_ledger_work_update");
    expect(visibleNames).toContain("project_ledger_work_complete");
    expect(instructions).toContain("keep one concise Project Ledger Work record");
    expect(instructions).toContain("Check for related Work first and reuse it");
    expect(instructions).toContain(
      "complete it after validating the requested outcome",
    );
    expect(instructions).not.toContain(
      "Do not attempt to mutate the Project Ledger",
    );

    let localVisibleNames: string[] = [];
    let localSearch: unknown;
    let localDescription: unknown;
    let localCatalogCall: unknown;
    let localDirectCall: unknown;
    const localTurnId = "turn-project-local-work";
    const localAgent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("search-1", "tool_search", {
          query: "project_ledger_create",
          include_disabled: true,
        }),
        toolCall("describe-1", "tool_describe", {
          ids: ["native:project_ledger_create"],
        }),
        toolCall("catalog-1", "tool_call", {
          id: "native:project_ledger_create",
          arguments: {
            kind: "work",
            id: "W-MUST-NOT-EXIST",
            title: "Must not exist",
            acceptance: "Must remain unavailable",
          },
        }),
        toolCall("direct-1", "project_ledger_create", {
          kind: "work",
          id: "W-MUST-NOT-EXIST",
          title: "Must not exist",
          acceptance: "Must remain unavailable",
        }),
      ]),
      (request) => {
        localVisibleNames = request.tools.map((tool) => tool.name);
        const messages = messagesWithToolResults(request);
        expect(messages).toHaveLength(4);
        localSearch = toolMessageOutput(
          messages.find((message) => message.toolCallId === "search-1"),
        );
        localDescription = toolMessageOutput(
          messages.find((message) => message.toolCallId === "describe-1"),
        );
        localCatalogCall = toolMessageOutput(
          messages.find((message) => message.toolCallId === "catalog-1"),
        );
        localDirectCall = toolMessageOutput(
          messages.find((message) => message.toolCallId === "direct-1"),
        );
        return { text: "세션 작업으로 처리했습니다.", toolCalls: [] };
      },
    ]));
    await localAgent.run({
      turn: turnRecord(fixture.root, {
        accessMode: "full_access",
        trackingMode: "local",
        projectId: "project-local",
        turnId: localTurnId,
      }),
      signal: new AbortController().signal,
    });
    expect(localVisibleNames).not.toContain("project_ledger_create");
    expect(localVisibleNames).not.toContain("project_ledger_work_complete");
    expect((localSearch as { results?: Array<{ id: string }> }).results ?? [])
      .not.toContainEqual(expect.objectContaining({
        id: "native:project_ledger_create",
      }));
    expect(localDescription).toMatchObject({
      ok: false,
      error: { code: "tool_failed", message: "Tool failed." },
    });
    expect(localCatalogCall).toMatchObject({ ok: false });
    expect(localDirectCall).toMatchObject({
      ok: false,
      error: { code: "tool_unavailable" },
    });
  } finally {
    fixture.close();
  }
});

test("Guided project Work initializes and closes Project Ledger through reviewed effects", async () => {
  const fixture = createFixture("guided-project-ledger-lifecycle");
  const previousFlag = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const ledgerRoot = join(
    fixture.root,
    "project-ledger",
    "projects",
    "guided-ledger-project",
  );
  writeFileSync(
    join(fixture.root, "package.json"),
    `${JSON.stringify({ name: "guided-ledger-project" })}\n`,
  );
  bindAppProject(fixture.dbPath, {
    id: "guided-project-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-ledger-project",
  });
  try {
    const turnId = "turn-guided-project-ledger-lifecycle";
    const planCalls = [toolCall("plan-1", "replace_work_plan", {
        objective: "Complete one tracked project change",
        actions: [{
          action_key: "create-ledger-work",
          description: "Create one concise Project Ledger Work record",
          effect: {
            capability: "project_ledger_create",
            target: "project-ledger:work:W-GUIDED-LIFECYCLE",
          },
        }, {
          action_key: "complete-ledger-work",
          description: "Complete the Project Ledger Work after validation",
          dependency_keys: ["create-ledger-work"],
          effect: {
            capability: "project_ledger_work_complete",
            target: "project-ledger:work:W-GUIDED-LIFECYCLE",
          },
        }],
        checks: ["The canonical Project Ledger Work is done"],
      })];
    const planReviewCalls = [toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan is concise and matches the project request.",
      })];
    const searchCalls = [
      toolCall("search-create", "tool_search", {
        query: "project_ledger_create",
        include_disabled: true,
      }),
      toolCall("search-complete", "tool_search", {
        query: "project_ledger_work_complete",
        include_disabled: true,
      }),
    ];
    const describeCalls = [toolCall("describe-effects", "tool_describe", {
      ids: [
        "native:project_ledger_create",
        "native:project_ledger_work_complete",
      ],
    })];
    const createCalls = [toolCall("create-1", "tool_call", {
      id: "native:project_ledger_create",
      arguments: {
        kind: "work",
        id: "W-GUIDED-LIFECYCLE",
        title: "Guided project lifecycle",
        status: "proposed",
        spec: "SPEC-GUIDED-LIFECYCLE",
        acceptance: "The tracked project result is validated and reported",
      },
    })];
    const completeCalls = [toolCall("complete-1", "tool_call", {
      id: "native:project_ledger_work_complete",
      arguments: {
        id: "W-GUIDED-LIFECYCLE",
        validation: "Lifecycle integration test passed",
        review: "The requested tracked outcome is complete",
        report: "The Guided result contains the completed outcome",
      },
    })];
    const reviewCalls = [
      toolCall("checkpoint-1", "record_work_checkpoint", {
        action_updates: [{ action_key: "create-ledger-work", status: "done" }, {
          action_key: "complete-ledger-work",
          status: "done",
        }],
        public_summary: "The Project Ledger Work was created and completed.",
        next_step: "Review the completed project result.",
      }),
      toolCall("result-review-1", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The Project Ledger Work was created and completed.",
      }),
    ];
    const completionCalls = [toolCall("completion-1", "record_work_review", {
        subject: "completion",
        verdict: "accept",
        summary: "The whole Work satisfies the original project request and checks.",
      })];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(planCalls),
      toolResponse(planReviewCalls),
      toolResponse(searchCalls),
      toolResponse(describeCalls),
      toolResponse(createCalls),
      toolResponse(completeCalls),
      toolResponse(reviewCalls),
      toolResponse(completionCalls),
      async () => {
        const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("disposition-1", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "completed",
          summary: "The tracked project change is complete.",
          action_updates: [{ action_key: "create-ledger-work", status: "done" }, {
            action_key: "complete-ledger-work", status: "done",
          }],
        })]);
      },
      (request) => {
        expect(existsSync(ledgerRoot)).toBe(true);
        expect(request.messages.some((message) => message.role === "tool")).toBe(true);
        return { text: "프로젝트 작업과 기록을 완료했습니다.", toolCalls: [] };
      },
      async () => {
        const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("disposition-1", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "completed",
          summary: "Project Ledger 효과와 검토 결과를 확인했습니다.",
        })]);
      },
      { text: "프로젝트 작업과 기록을 완료했습니다.", toolCalls: [] },
    ]), { butlerHome: process.cwd() });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    const delivered = await runtime.runTurn(projectRunCommand(fixture.root, turnId));
    expect(delivered)
      .toMatchObject({
      kind: "delivered",
      content: "프로젝트 작업과 기록을 완료했습니다.",
    });
    const journal = fixture.stores.guidedToolJournal.list(turnId);
    expect(journal.find((entry) => entry.toolName === "tool_search" &&
      JSON.stringify(entry.arguments).includes("project_ledger_create"))?.result)
      .toMatchObject({ results: [expect.objectContaining({
        id: "native:project_ledger_create",
        enabled: true,
      })] });
    expect(journal.find((entry) => entry.toolName === "tool_describe")?.result)
      .toMatchObject({ ok: true, missing: [] });
    expect(journal.find((entry) => entry.toolName === "project_ledger_create")?.result)
      .toMatchObject({ ok: true });
    expect(journal.find((entry) => entry.toolName === "project_ledger_work_complete")?.result)
      .toMatchObject({ ok: true });
    expect(existsSync(join(ledgerRoot, "project.json"))).toBe(true);
    expect(existsSync(join(ledgerRoot, "work", "W-GUIDED-LIFECYCLE", "work.md")))
      .toBe(true);
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(work).toMatchObject({
      status: "completed",
      latestResultReview: { verdict: "accept" },
      latestCompletionValidation: { verdict: "accept" },
    });
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toHaveLength(2);
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    } else {
      process.env.BUTLER_PHASE_TOOL_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("Guided Project Ledger mutation uses bounded workspace context without App rows", async () => {
  for (const archived of [false, true]) {
    const fixture = createFixture(
      archived ? "guided-archived-project-binding" : "guided-missing-project-binding",
    );
    const ledgerId = archived
      ? "archived-ledger-must-not-exist"
      : "missing-ledger-must-not-exist";
    writeFileSync(
      join(fixture.root, "package.json"),
      `${JSON.stringify({ name: ledgerId })}\n`,
    );
    prepareAppProjectsTable(fixture.dbPath);
    if (archived) {
      bindAppProject(fixture.dbPath, {
        id: "guided-project-session",
        workspacePath: fixture.root,
        ledgerProjectId: ledgerId,
        archived: true,
      });
    }
    try {
      let mutationResult: unknown;
      const turnId = archived
        ? "turn-archived-project-binding"
        : "turn-missing-project-binding";
      const agent = fixture.agent(scriptedModelRound([
        toolResponse([
          toolCall("plan-1", "replace_work_plan", {
            objective: "Verify the persistent mutation boundary",
            actions: [{
              action_key: "create-ledger-work",
              description: "Create one Project Ledger Work",
              effect: {
                capability: "project_ledger_create",
                target: "project-ledger:work:W-BINDING-FAIL-CLOSED",
              },
            }],
            checks: ["The bounded workspace context owns project resolution"],
          }),
          toolCall("review-1", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The boundary check is safe and scoped.",
          }),
          toolCall("mutation-1", "project_ledger_create", {
            kind: "work",
            id: "W-BINDING-FAIL-CLOSED",
            title: "Create from bounded context",
            acceptance: "No App database lookup is required",
          }),
        ]),
        () => {
          mutationResult = fixture.stores.guidedToolJournal.list(turnId)
            .at(-1)?.result;
          return { text: "bounded context로 기록했습니다.", toolCalls: [] };
        },
      ]), { butlerHome: process.cwd() });
      const runtime = createGuidedTurnRuntime({
        admission: fixture.stores.admission,
        turns: fixture.stores.turns,
        messages: fixture.stores.messages,
        committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
        agent,
      });
      await runtime.runTurn(projectRunCommand(fixture.root, turnId));

      expect(mutationResult).toMatchObject({ ok: true });
      expect(existsSync(join(
        fixture.root,
        "project-ledger",
        "projects",
        ledgerId,
      ))).toBe(true);
    } finally {
      fixture.close();
    }
  }
});

test("Guided agent legacy fallback never grants full access without an admitted access mode", async () => {
  const fixture = createFixture("guided-legacy-policy");
  try {
    const turn = turnRecord(fixture.root, { turnId: "legacy-turn" });
    delete turn.context.executionPolicy;
    turn.modelSelection.controls = {};
    let names: string[] = [];
    let prompt = "";
    const agent = fixture.agent({
      async runRound(request) {
        names = request.tools.map((tool) => tool.name);
        prompt = request.messages[0]?.content ?? "";
        return { text: "읽기 전용으로 확인했습니다.", toolCalls: [] };
      },
    });
    await agent.run({ turn, signal: new AbortController().signal });
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(prompt).toContain("access: read_only");
  } finally {
    fixture.close();
  }
});

test("Guided agent treats admitted Turn access as the upper permission bound", async () => {
  const fixture = createFixture("guided-access-bound");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "bounded-turn",
      accessMode: "full_access",
    });
    turn.modelSelection.controls = { accessMode: "read_only" };
    turn.context.executionPolicy!.requiredNativeToolProfiles = [
      "automation",
      "memory-write",
      "mcp",
    ];
    turn.context.executionPolicy!.requiredNativeTools = [
      "create_automation",
      "update_explicit_memory",
      "call_mcp_tool",
    ];
    let names: string[] = [];
    const unsafeAvailability: boolean[] = [];
    let deniedMutation: unknown;
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("search-automation", "tool_search", {
          query: "create_automation",
          include_disabled: true,
        }),
        toolCall("search-memory", "tool_search", {
          query: "update_explicit_memory",
          include_disabled: true,
        }),
        toolCall("search-mcp", "tool_search", {
          query: "call_mcp_tool",
          include_disabled: true,
        }),
        toolCall("write-forbidden", "write_file", {
          path: "forbidden.txt",
          content: "no",
          overwrite: false,
        }),
      ]),
      (request) => {
        names = request.tools.map((tool) => tool.name);
        const messages = messagesWithToolResults(request);
        expect(messages).toHaveLength(4);
        const results = [
          "search-automation",
          "search-memory",
          "search-mcp",
        ].map((id) => toolMessageOutput(
          messages.find((message) => message.toolCallId === id),
        )) as Array<{ results?: Array<{ name: string; enabled: boolean }> }>;
        for (const [index, name] of [
          "create_automation",
          "update_explicit_memory",
          "call_mcp_tool",
        ].entries()) {
          unsafeAvailability.push(
            results[index]?.results?.find((entry) => entry.name === name)?.enabled ?? false,
          );
        }
        deniedMutation = toolMessageOutput(
          messages.find((message) => message.toolCallId === "write-forbidden"),
        );
        return { text: "읽기 권한 범위에서 확인했습니다.", toolCalls: [] };
      },
    ]));
    await agent.run({ turn, signal: new AbortController().signal });
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
    expect(unsafeAvailability).toEqual([false, false, false]);
    expect(deniedMutation).toMatchObject({
      ok: false,
      error: { code: "tool_unavailable" },
    });
    expect(existsSync(join(fixture.root, "forbidden.txt"))).toBe(false);
  } finally {
    fixture.close();
  }
});

test("Guided discovery exposes registry reads and enables reviewed MCP effects only in full access", async () => {
  const fixture = createFixture("guided-unsupported-effects");
  try {
    upsertMcpServer(fixture.root, {
      id: "fixture",
      display_name: "Fixture MCP",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["--eval", fixtureMcpServerEval()],
      cwd: process.cwd(),
    });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-unsupported-effects-turn",
      accessMode: "full_access",
      trackingMode: "local",
    });
    const authorizedNames = authorizedToolDefinitions(turn)
      .map((tool) => tool.name);
    for (const accessMode of ["read_only", "ask_first"] as const) {
      expect(authorizedToolDefinitions(turnRecord(fixture.root, {
        turnId: `guided-mcp-${accessMode}`,
        accessMode,
      })).map((tool) => tool.name)).not.toContain("call_mcp_tool");
    }
    expect(authorizedNames).toContain("list_automations");
    expect(authorizedNames).toContain("list_mcp_capabilities");
    expect(authorizedNames).toContain("read_mcp_resource");
    expect(authorizedNames).toContain("query_memory");
    expect(authorizedNames).toContain("get_usage_monitor");
    expect(authorizedNames).not.toContain("create_automation");
    expect(authorizedNames).toContain("call_mcp_tool");
    expect(authorizedNames).not.toContain("transform_public_data_table");

    let initialNames: string[] = [];
    let automationSearch: unknown;
    let mcpSearch: unknown;
    let descriptions: unknown;
    let automationList: unknown;
    let capabilityList: unknown;
    let mcpCapabilities: unknown;
    let mcpResource: unknown;
    let memoryQuery: unknown;
    let usageMonitor: unknown;
    let mcpCall: unknown;
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("automation-search", "tool_search", {
          provider: "native",
          category: "automation",
          include_disabled: true,
        }),
        toolCall("mcp-search", "tool_search", {
          provider: "mcp",
          category: "mcp",
          capability: "issue",
          include_disabled: true,
        }),
        toolCall("describe", "tool_describe", {
          ids: [
            "native:create_automation",
            "native:list_automations",
            "native:list_tool_capabilities",
            "native:call_mcp_tool",
            "native:list_mcp_capabilities",
            "native:read_mcp_resource",
            "native:query_memory",
            "native:get_usage_monitor",
            "mcp:fixture:find_issue",
          ],
        }),
        toolCall("automation-list", "tool_call", {
          id: "native:list_automations",
          arguments: {},
        }),
        toolCall("capability-list", "tool_call", {
          id: "native:list_tool_capabilities",
          arguments: { include_disabled: true },
        }),
        toolCall("mcp-capabilities", "tool_call", {
          id: "native:list_mcp_capabilities",
          arguments: {},
        }),
        toolCall("mcp-resource", "tool_call", {
          id: "native:read_mcp_resource",
          arguments: { server_id: "fixture", uri: "butler://fixture" },
        }),
        toolCall("memory", "tool_call", {
          id: "native:query_memory",
          arguments: { scope: "session" },
        }),
        toolCall("usage", "tool_call", {
          id: "native:get_usage_monitor",
          arguments: {},
        }),
        toolCall("mcp-call", "tool_call", {
          id: "mcp:fixture:find_issue",
          arguments: { query: "BTCC" },
        }),
      ]),
      (request) => {
        initialNames = request.tools.map((tool) => tool.name);
        const results = fixture.stores.guidedToolJournal.list(turn.turnId)
          .map((entry) => entry.result);
        [automationSearch, mcpSearch, descriptions, automationList, capabilityList,
          mcpCapabilities, mcpResource, memoryQuery, usageMonitor, mcpCall] = results;
        return { text: "현재 R3에서 실행 가능한 도구 범위를 확인했습니다.", toolCalls: [] };
      },
    ]));

    await agent.run({
      turn,
      signal: new AbortController().signal,
    });

    for (const name of [
      "list_automations",
      "list_mcp_capabilities",
      "read_mcp_resource",
      "query_memory",
      "get_usage_monitor",
    ]) {
      expect(initialNames).not.toContain(name);
    }

    const automationResults = (
      automationSearch as {
        results: Array<{
          name: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }
    ).results;
    expect(automationResults.find((item) => item.name === "list_automations"))
      .toEqual(expect.objectContaining({
        enabled: true,
        disabled_reason: null,
      }));
    for (const name of [
      "create_automation",
      "delete_automation",
      "run_due_automations",
    ]) {
      expect(automationResults.find((item) => item.name === name))
        .toEqual(expect.objectContaining({
          enabled: false,
          disabled_reason: expect.stringContaining(
            "does not yet have a typed automation effect adapter",
          ),
        }));
    }

    expect(
      (mcpSearch as {
        results: Array<{
          id: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }).results,
    ).toContainEqual(expect.objectContaining({
      id: "mcp:fixture:find_issue",
      enabled: true,
      disabled_reason: null,
    }));

    const byId = new Map(
      (descriptions as {
        descriptions: Array<{
          id: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }).descriptions.map((item) => [item.id, item]),
    );
    expect(byId.get("native:list_automations")?.enabled).toBe(true);
    expect(byId.get("native:list_mcp_capabilities")?.enabled).toBe(true);
    expect(byId.get("native:read_mcp_resource")?.enabled).toBe(true);
    expect(byId.get("native:query_memory")?.enabled).toBe(true);
    expect(byId.get("native:get_usage_monitor")?.enabled).toBe(true);
    expect(byId.get("native:create_automation")).toEqual(
      expect.objectContaining({
        enabled: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a typed automation effect adapter",
        ),
      }),
    );
    expect(byId.get("native:call_mcp_tool")).toEqual(expect.objectContaining({
      enabled: true,
      disabled_reason: null,
    }));
    expect(byId.get("mcp:fixture:find_issue")).toEqual(expect.objectContaining({
      enabled: true,
      disabled_reason: null,
    }));
    expect(automationList).toMatchObject({
      ok: true,
      automations: [],
    });
    const capabilityByName = new Map(
      (capabilityList as {
        capabilities: Array<{
          name: string;
          enabled: boolean;
          current_turn_callable: boolean;
          disabled_reason: string | null;
        }>;
      }).capabilities.map((item) => [item.name, item]),
    );
    expect(capabilityByName.get("list_automations")).toEqual(
      expect.objectContaining({
        enabled: true,
        current_turn_callable: true,
      }),
    );
    expect(capabilityByName.get("create_automation")).toEqual(
      expect.objectContaining({
        enabled: false,
        current_turn_callable: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a typed automation effect adapter",
        ),
      }),
    );
    expect(capabilityByName.get("call_mcp_tool")).toEqual(
      expect.objectContaining({
        enabled: true,
        current_turn_callable: true,
        disabled_reason: null,
      }),
    );
    expect(mcpCapabilities).toMatchObject({
      ok: true,
      servers: [
        {
          id: "fixture",
          ok: true,
        },
      ],
    });
    expect(mcpResource).toMatchObject({
      ok: true,
      server_id: "fixture",
      uri: "butler://fixture",
    });
    expect(JSON.stringify(mcpResource)).toContain("fixture");
    expect(memoryQuery).toMatchObject({ ok: true });
    expect(usageMonitor).toMatchObject({ ok: true });
    expect(mcpCall).toMatchObject({
      ok: false,
      error: {
        code: "effect_work_required",
      },
      bridge_invocation: { id: "mcp:fixture:find_issue" },
    });
  } finally {
    fixture.close();
  }
});

test("flag-off Guided discovery and capability lists preserve the prior surface", async () => {
  const fixture = createFixture("guided-exact-replay-off-discovery");
  const previous = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  try {
    const turn = turnRecord(fixture.root, { trackingMode: "none" });
    turn.context.executionPolicy!.requiredNativeTools = ["list_tool_capabilities"];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        expect(request.tools.map((tool) => tool.name))
          .not.toContain("read_operation_results");
        expect(request.tools.map((tool) => tool.name))
          .toContain("list_tool_capabilities");
        return toolResponse([
        toolCall("search-exact", "tool_search", {
          query: "read_operation_results", include_disabled: true,
        }),
        toolCall("describe-exact", "tool_describe", {
          ids: ["native:read_operation_results"],
        }),
        toolCall("capabilities", "list_tool_capabilities", {
          include_disabled: true,
        }),
        ]);
      },
      (request) => {
        const messages = messagesWithToolResults(request);
        const result = toolMessageOutput(messages
          .find((message) => message.toolCallId === "search-exact")) as {
            results?: Array<{ name: string }>;
          };
        expect(result.results?.map((entry) => entry.name) ?? [])
          .not.toContain("read_operation_results");
        expect(toolMessageOutput(messages.find((message) =>
          message.toolCallId === "describe-exact"))).toMatchObject({
            ok: false,
            error: { code: "tool_failed", message: "Tool failed." },
          });
        const capabilityResult = toolMessageOutput(messages.find((message) =>
          message.toolCallId === "capabilities")) as {
            ok?: boolean;
            current_turn_surface_known?: boolean;
            capabilities?: Array<{ name: string }>;
          };
        expect(capabilityResult).toMatchObject({
          ok: true,
          current_turn_surface_known: true,
        });
        expect(capabilityResult.capabilities?.map((entry) => entry.name) ?? [])
          .not.toContain("read_operation_results");
        expect(JSON.stringify(capabilityResult))
          .not.toContain("read_operation_results");
        return { text: "exact replay remains disabled", toolCalls: [] };
      },
    ]));
    const output = await agent.run({
      turn,
      signal: new AbortController().signal,
    });
    expect(output.content).toBe("exact replay remains disabled");
  } finally {
    if (previous === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previous;
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("flag-on Guided capability list exposes the canonical exact reader as callable", async () => {
  const fixture = createFixture("guided-exact-replay-on-capabilities");
  const previous = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  try {
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        expect(request.tools.map((tool) => tool.name))
          .toContain("read_operation_results");
        expect(request.tools.map((tool) => tool.name))
          .toContain("list_tool_capabilities");
        return toolResponse([toolCall("capabilities", "list_tool_capabilities", {
          include_disabled: true,
        })]);
      },
      (request) => {
        const result = toolMessageOutput(messagesWithToolResults(request)
          .find((message) => message.toolCallId === "capabilities")) as {
            capabilities?: Array<{
              name: string;
              enabled: boolean;
              current_turn_selected: boolean;
              current_turn_callable: boolean;
            }>;
          };
        const exact = result.capabilities?.filter((entry) =>
          entry.name === "read_operation_results");
        expect(exact).toEqual([expect.objectContaining({
          enabled: true,
          current_turn_selected: true,
          current_turn_callable: true,
        })]);
        return { text: "canonical exact reader is callable", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, {
      accessMode: "full_access", trackingMode: "local",
    });
    turn.context.executionPolicy!.requiredNativeTools = ["list_tool_capabilities"];
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const output = await agent.run({
      turn,
      signal: new AbortController().signal,
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });
    expect(output.content).toBe("canonical exact reader is callable");
  } finally {
    if (previous === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previous;
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("flag-off required exact capability fails before Guided provider dispatch", async () => {
  const fixture = createFixture("guided-exact-replay-off-required");
  const previous = process.env.BUTLER_OPERATION_RESULT_REPLAY;
  delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
  let calls = 0;
  try {
    const agent = fixture.agent({ async runRound() {
      calls += 1;
      return { text: "must not dispatch", toolCalls: [] };
    } });
    const turn = turnRecord(fixture.root, { accessMode: "full_access" });
    turn.context.executionPolicy!.requiredNativeTools = ["read_operation_results"];
    await expect(agent.run({ turn, signal: new AbortController().signal }))
      .rejects.toThrow("required tool is unavailable while exact replay is disabled");
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    else process.env.BUTLER_OPERATION_RESULT_REPLAY = previous;
    fixture.close();
  }
});

test("Guided full access invokes a described MCP tool through the reviewed effect journal", async () => {
  const fixture = createFixture("guided-mcp-effect");
  const callLog = join(fixture.root, "mcp-calls.log");
  try {
    upsertMcpServer(fixture.root, {
      id: "fixture",
      display_name: "Fixture MCP",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["--eval", fixtureMcpServerEval()],
      cwd: process.cwd(),
      env: [{
        key: "MCP_CALL_LOG",
        source: "literal",
        value: callLog,
      }],
    });
    const turnId = "guided-mcp-effect-turn";
    let callResult: unknown;
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("mcp-start", "start_work", {
        objective: "Find the requested issue through the configured MCP server",
      })]),
      toolResponse([toolCall("mcp-plan", "replace_work_plan", {
        objective: "Find the requested issue through the configured MCP server",
        actions: [{
          action_key: "query-configured-mcp",
          description: "Call the configured issue tool",
          effect: {
            capability: "call_mcp_tool",
            target: "mcp:fixture/find_issue",
          },
        }],
        checks: ["The configured tool returns the matching issue result"],
      })]),
      toolResponse([toolCall("mcp-plan-review", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The configured MCP call is the requested external effect.",
      })]),
      toolResponse([toolCall("mcp-describe", "tool_describe", {
        ids: ["mcp:fixture:find_issue"],
      })]),
      toolResponse([toolCall("mcp-call", "tool_call", {
        id: "mcp:fixture:find_issue",
        arguments: { query: "BTCC" },
      })]),
      async (request) => {
        const records = fixture.stores.guidedToolJournal.list(turnId);
        callResult = records.find((record) =>
          (record.result as { bridge_invocation?: { id?: string } } | undefined)
            ?.bridge_invocation?.id === "mcp:fixture:find_issue",
        )?.result;
        expect(messagesWithToolResults(request)).toHaveLength(5);
        const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("mcp-open", "record_work_disposition", {
          work_id: work!.workId,
          disposition: "open",
          summary: "The requested MCP result is ready to report.",
          remaining_actions: ["Report the result to the user"],
        })]);
      },
      { text: "MCP에서 요청한 이슈를 확인했습니다.", toolCalls: [] },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });

    const result = await runtime.runTurn(localRunCommand(fixture.root, turnId));

    expect(result).toMatchObject({
      kind: "delivered",
      content: "MCP에서 요청한 이슈를 확인했습니다.",
    });
    expect(callResult).toMatchObject({
      ok: true,
      server_id: "fixture",
      tool_name: "find_issue",
      result: {
        content: [{ type: "text", text: "issue:BTCC" }],
      },
      effect_receipt: {
        capability: "call_mcp_tool",
        target: "mcp:fixture/find_issue",
        replayed: false,
      },
      bridge_invocation: { id: "mcp:fixture:find_issue" },
    });
    expect(readFileSync(callLog, "utf8")).toBe("find_issue\n");
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toEqual([
        expect.objectContaining({
          capability: "call_mcp_tool",
          sanitizedTarget: "mcp:fixture/find_issue",
          status: "applied",
          dispatchAttempts: 1,
        }),
      ]);
  } finally {
    fixture.close();
  }
});

test("Guided replay keeps native read-only MCP and automation tools retryable", () => {
  for (const name of [
    "bind_session_git_worktree",
    "list_automations",
    "list_mcp_capabilities",
    "read_mcp_resource",
    "list_tool_capabilities",
  ]) {
    expect(isReplaySafeTool(name)).toBe(true);
  }
  expect(isReplaySafeTool("create_automation")).toBe(false);
  expect(isReplaySafeTool("call_mcp_tool")).toBe(false);
  expect(isReplaySafeTool("transform_public_data_table")).toBe(false);
});

test("direct and tool_call file mutations use the same reviewed effect gate", async () => {
  const fixture = createFixture("guided-effect-bridge");
  try {
    let direct: unknown;
    let bridged: unknown;
    const turnId = "turn-effect-bridge";
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("direct-1", "write_file", {
          path: "direct.txt",
          content: "blocked",
        }),
        toolCall("bridged-1", "tool_call", {
          id: "native:write_file",
          arguments: {
            path: "bridged.txt",
            content: "blocked",
          },
        }),
      ]),
      (request) => {
        const results = fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result);
        [direct, bridged] = results;
        expect(messagesWithToolResults(request)).toHaveLength(2);
        return {
          text: "검토된 Plan이 없어 파일을 변경하지 않았습니다.",
          toolCalls: [],
        };
      },
    ]));

    await agent.run({
      turn: turnRecord(fixture.root, { turnId }),
      signal: new AbortController().signal,
    });

    expect(direct).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
    });
    expect(bridged).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
      bridge_invocation: { id: "native:write_file" },
    });
    expect(existsSync(join(fixture.root, "direct.txt"))).toBe(false);
    expect(existsSync(join(fixture.root, "bridged.txt"))).toBe(false);
  } finally {
    fixture.close();
  }
});

test("Guided catalog and tool_call execute the same simple write_file contract", async () => {
  const fixture = createFixture("guided-write-file-bridge");
  try {
    let description: unknown;
    let writeResult: unknown;
    const turnId = "turn-guided-write-file-bridge";
    const calls = [
      toolCall("plan-1", "replace_work_plan", {
        objective: "Create bridged.txt",
        actions: [{
          action_key: "write-bridged-file",
          description: "Write the requested file",
          effect: {
            capability: "write_file",
            target: "workspace:bridged.txt",
          },
        }],
        checks: ["bridged.txt contains the requested content"],
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan directly creates the requested file.",
      }),
      toolCall("describe-1", "tool_describe", {
        ids: ["native:write_file"],
      }),
      toolCall("write-1", "tool_call", {
        id: "native:write_file",
        arguments: {
          path: "bridged.txt",
          content: "bridge contract works\n",
        },
      }),
      toolCall("result-review-1", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The requested file was written with the exact content.",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      async () => {
        const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("disposition-1", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "completed",
          summary: "The requested file was written.",
          action_updates: [{ action_key: "write-bridged-file", status: "done" }],
        })]);
      },
      (request) => {
        const results = fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result);
        description = results[2];
        writeResult = results[3];
        expect(messagesWithToolResults(request)).toHaveLength(calls.length + 1);
        return { text: "브리지 경로로 파일을 작성했습니다.", toolCalls: [] };
      },
      async () => {
        const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("bridge-disposition", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "open",
          summary: "파일을 작성했고 후속 확인이 남았습니다.",
          remaining_actions: ["사용자에게 파일 결과를 전달한다"],
        })]);
      },
      { text: "브리지 경로로 파일을 작성했습니다.", toolCalls: [] },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(localRunCommand(fixture.root, turnId)))
      .toMatchObject({
        kind: "delivered",
        content: "브리지 경로로 파일을 작성했습니다.",
      });

    const encodedDescription = JSON.stringify(description);
    expect(encodedDescription).not.toContain("expected_sha256");
    expect(encodedDescription).not.toContain("overwrite");
    expect(description).toMatchObject({
      ok: true,
      descriptions: [{
        id: "native:write_file",
        enabled: true,
        schema: { required: ["path", "content"] },
      }],
    });
    expect(writeResult).toMatchObject({
      ok: true,
      effect_receipt: {
        capability: "write_file",
        target: "workspace:bridged.txt",
      },
      bridge_invocation: { id: "native:write_file" },
    });
    expect(readFileSync(join(fixture.root, "bridged.txt"), "utf8"))
      .toBe("bridge contract works\n");
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    fixture.close();
  }
});

test("Guided agent applies a small edit through the reviewed durable effect", async () => {
  const fixture = createFixture("guided-edit-file");
  try {
    writeFileSync(
      join(fixture.root, "styles.css"),
      "body {\n  overflow-x: auto;\n}\n",
    );
    const results: unknown[] = [];
    let editResult: unknown;
    const turnId = "turn-guided-edit-file";
    const calls = [
      toolCall("plan-1", "replace_work_plan", {
        objective: "Correct the visible horizontal overflow",
        actions: [{
          action_key: "correct-style",
          description: "Make the requested contained workspace correction",
          effect: {
            capability: "workspace mutation",
            target: "workspace:requested-source-change",
          },
        }],
        checks: ["The resulting stylesheet contains the requested correction"],
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The small contained correction matches the request.",
      }),
      toolCall("edit-1", "edit_file", {
        path: "styles.css",
        start_line: 2,
        old_text: "  overflow-x: auto;\n",
        new_text: "  overflow-x: hidden;\n",
      }),
      toolCall("checkpoint-1", "record_work_checkpoint", {
        action_updates: [{
          action_key: "correct-style",
          status: "done",
        }],
        public_summary: "The requested stylesheet correction is present.",
        next_step: "Review the corrected stylesheet.",
      }),
      toolCall("result-review-1", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The requested stylesheet correction is present.",
      }),
      toolCall("completion-1", "record_work_review", {
        subject: "completion",
        verdict: "accept",
        summary: "The whole Work satisfies the requested stylesheet correction.",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      async () => {
        const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("disposition-1", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "completed",
          summary: "The requested stylesheet correction is complete.",
          action_updates: [{ action_key: "correct-style", status: "done" }],
        })]);
      },
      (request) => {
        results.push(...fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result));
        const messages = messagesWithToolResults(request);
        editResult = toolMessageOutput(
          messages.find((message) => message.toolCallId === "edit-1"),
        );
        expect(messages).toHaveLength(calls.length + 1);
        return { text: "가로 넘침 수정을 완료했습니다.", toolCalls: [] };
      },
      async () => {
        const bound = await fixture.stores.durableWork.boundWorkForTurn(turnId);
        return toolResponse([toolCall("edit-disposition", "record_work_disposition", {
          work_id: bound!.workId,
          disposition: "completed",
          summary: "가로 넘침 수정과 검증을 완료했습니다.",
        })]);
      },
      { text: "가로 넘침 수정을 완료했습니다.", toolCalls: [] },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(localRunCommand(fixture.root, turnId)))
      .toMatchObject({
      kind: "delivered",
      content: "가로 넘침 수정을 완료했습니다.",
    });
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(editResult).toMatchObject({
      ok: true,
      start_line: 2,
      effect_receipt: {
        capability: "edit_file",
        target: "workspace:styles.css",
        start_line: 2,
      },
    });
    expect(readFileSync(join(fixture.root, "styles.css"), "utf8"))
      .toBe("body {\n  overflow-x: hidden;\n}\n");
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(work?.status).toBe("completed");
    expect(work?.latestCompletionValidation?.verdict).toBe("accept");
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toEqual([
        expect.objectContaining({
          capability: "edit_file",
          sanitizedTarget: "workspace:styles.css",
          status: "applied",
        }),
      ]);
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    fixture.close();
  }
});

test("reviewed run_command mutation records a receipt and pushes without force", async () => {
  const fixture = createFixture("guided-command-effect");
  try {
    const workspace = join(fixture.root, "workspace");
    const remote = join(fixture.root, "remote.git");
    mkdirSync(workspace, { recursive: true });
    runGit(["init", "-b", "main"], workspace);
    runGit(["init", "--bare", remote], fixture.root);
    runGit(["remote", "add", "origin", remote], workspace);
    writeFileSync(join(workspace, "deliverable.txt"), "reviewed command effect\n");

    let beforeWork: unknown;
    let beforeReview: unknown;
    let pushed: unknown;
    let nonzero: unknown;
    const turnId = "turn-guided-command-effect";
    const calls = [
      toolCall("before-work-1", "run_command", {
        command: "printf blocked > before-work.txt",
        summary: "Plan 검토 전 변경 차단을 확인합니다.",
        state_effect: "mutation",
      }),
      toolCall("plan-1", "replace_work_plan", {
        objective: "Commit and publish the requested contained workspace result",
        actions: [{
          action_key: "publish-result",
          description: "Commit the requested result and publish it to the configured remote",
          effect: {
            capability: "workspace mutation",
            target: "workspace:reviewed-command-result",
          },
        }],
        checks: ["The commit exists on the configured non-force remote branch"],
      }),
      toolCall("before-review-1", "run_command", {
        command: "printf blocked > before-review.txt",
        summary: "Plan 검토 전 변경 차단을 확인합니다.",
        state_effect: "mutation",
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The contained Git command directly produces the requested result.",
      }),
      toolCall("push-1", "run_command", {
        command: [
          "git add deliverable.txt",
          "git -c user.name=Butler -c user.email=butler@example.invalid commit -m reviewed-command-effect",
          "git push origin HEAD:main",
        ].join(" && "),
        summary: "검토된 결과를 원격 main 브랜치에 게시합니다.",
        state_effect: "mutation",
      }),
      toolCall("nonzero-1", "run_command", {
        command: "printf partial > command-failed.txt; exit 7",
        summary: "실패한 명령의 부분 결과를 확인합니다.",
        state_effect: "mutation",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      (request) => {
        const results = fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result);
        [beforeWork, , beforeReview, , pushed, nonzero] = results;
        expect(messagesWithToolResults(request)).toHaveLength(calls.length);
        return { text: "검토된 명령 실행 결과를 보고합니다.", toolCalls: [] };
      },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });

    expect(await runtime.runTurn(localRunCommand(workspace, turnId)))
      .toMatchObject({ kind: "delivered" });
    expect(beforeWork).toMatchObject({
      ok: false,
      error: { code: "effect_work_required", recoverable: true },
    });
    expect(beforeReview).toMatchObject({
      ok: false,
      error: { code: "effect_plan_review_required", recoverable: true },
    });
    expect(existsSync(join(workspace, "before-work.txt"))).toBe(false);
    expect(existsSync(join(workspace, "before-review.txt"))).toBe(false);
    expect(pushed).toMatchObject({
      ok: true,
      exit_code: 0,
      sandbox: "full_access_contained",
      effect_receipt: {
        capability: "run_command",
        target: "workspace-command:.",
      },
    });
    expect(nonzero).toMatchObject({
      ok: false,
      exit_code: 7,
      command_outcome_observed: true,
      effect_receipt: { capability: "run_command" },
    });
    expect(readFileSync(join(workspace, "command-failed.txt"), "utf8"))
      .toBe("partial");
    expect(runGit(["rev-parse", "refs/heads/main"], remote, true))
      .toMatch(/^[a-f0-9]{40}$/u);
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toEqual([
        expect.objectContaining({ capability: "run_command", status: "applied" }),
        expect.objectContaining({ capability: "run_command", status: "applied" }),
      ]);
  } finally {
    fixture.close();
  }
});

test("Guided agent renders CSV text once and passes image attachments to the provider", async () => {
  const fixture = createFixture("guided-attachments");
  try {
    const csvPath = join(fixture.root, "products.csv");
    const imagePath = join(fixture.root, "photo.png");
    writeFileSync(csvPath, "name,pork_percent\nA,91\nB,82\n");
    writeFileSync(imagePath, "not-a-real-image");
    let prompt = "";
    let attachments: unknown[] = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        prompt = request.messages[0]?.content ?? "";
        attachments = [...(request.attachments ?? [])];
        return { text: "분석했습니다.", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, {
      attachments: [{
        id: "csv-1",
        kind: "document",
        mimeType: "text/csv",
        fileName: "products.csv",
        localPath: csvPath,
      }, {
        id: "image-1",
        kind: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        localPath: imagePath,
      }],
    });

    await agent.run({ turn, signal: new AbortController().signal });

    expect(prompt.match(/name,pork_percent/g)?.length).toBe(1);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "image-1",
      kind: "image",
      mimeType: "image/png",
      fileName: "photo.png",
      localPath: imagePath,
    });
  } finally {
    fixture.close();
  }
});

test("Guided agent offers the existing Work controls plus disposition and keeps direct turns free of Work", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  delete process.env.BUTLER_PHASE_TOOL_SURFACE;
  const fixture = createFixture("guided-work-surface");
  try {
    let visibleNames: string[] = [];
    let toolSurfaceDigest: string | undefined;
    const turn = turnRecord(fixture.root, {
      turnId: "turn-direct-with-work-available",
      trackingMode: "local",
    });
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        visibleNames = request.tools.map((tool) => tool.name);
        toolSurfaceDigest = request.toolSurfaceDigest;
        return { text: "안녕하세요.", toolCalls: [] };
      },
    ]));

    const outcome = await agent.run({
      turn,
      signal: new AbortController().signal,
    });

    expect(visibleNames).toContain("replace_work_plan");
    expect(visibleNames).toContain("record_work_checkpoint");
    expect(visibleNames).toContain("record_work_review");
    expect(visibleNames).toContain("record_work_disposition");
    expect(visibleNames).not.toContain("update_todo_list");
    expect(visibleNames).not.toContain("list_todo_list");
    expect(visibleNames).not.toContain("list_work_streams");
    expect(visibleNames).not.toContain("update_work_stream_state");
    expect(outcome.route).toBe("direct");
    expect(toolSurfaceDigest).toBeUndefined();
    expect(await fixture.stores.durableWork.boundWorkForTurn(turn.turnId)).toBeNull();
  } finally {
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("feature Guided Turn refreshes disposition from durable Work and effect facts", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-round-tool-surface");
  try {
    const turnId = "guided-round-tool-surface-turn";
    const command = localRunCommand(fixture.root, turnId);
    const effectId = "effect-round-surface";
    const surfaces: string[][] = [];
    const digests: string[] = [];
    const modelRound: ModelRoundPort = {
      async runRound(request) {
        surfaces.push(request.tools.map((tool) => tool.name));
        digests.push(request.toolSurfaceDigest ?? "");
        if (surfaces.length === 1) {
          expect(surfaces[0]).not.toContain("record_work_disposition");
          expect(surfaces[0]).not.toContain("record_work_checkpoint");
          expect(surfaces[0]).not.toContain("record_work_review");
          return toolResponse([toolCall("round-surface-plan", "replace_work_plan", {
            start_new: true,
            objective: "Create and inspect the page",
            actions: [{ action_key: "create-page", dependency_keys: [] }],
            checks: [],
          })]);
        }
        if (surfaces.length === 2) {
          expect(await fixture.stores.durableWork.loadContext({
            turnId,
            sessionId: command.sessionId,
          })).toMatchObject({ work: { status: "open" } });
          expect(surfaces[1]).toContain("record_work_checkpoint");
          expect(surfaces[1]).toContain("record_work_review");
          expect(surfaces[1]).toContain("record_work_disposition");
          const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          expect(work).not.toBeNull();
          fixture.stores.guidedEffectJournal.prepare({
            effectId,
            receiptId: "receipt-round-surface",
            idempotencyKey: "idempotency-round-surface",
            identitySha256: "1".repeat(64),
            requestSha256: "2".repeat(64),
            inputSha256: "3".repeat(64),
            targetSha256: "4".repeat(64),
            workId: work!.workId,
            planRevisionId: work!.currentPlan!.planRevisionId,
            actionKey: "create-page",
            capability: "write_file",
            sanitizedTarget: "workspace:index.html",
          });
          return toolResponse([toolCall("invalid-read-before-terminal", "read_file", {})]);
        }
        if (surfaces.length === 3) {
          expect(surfaces[2]).not.toContain("record_work_disposition");
          expect(fixture.stores.guidedEffectJournal.claimDispatch(effectId, 1))
            .toMatchObject({ status: "dispatching", journalRevision: 2 });
          expect(fixture.stores.guidedEffectJournal.recordFailed(effectId, 2, {
            code: "effect_dispatch_failed",
            message: "terminal test outcome",
            recoverable: false,
          })).toMatchObject({ status: "failed", journalRevision: 3 });
          return toolResponse([toolCall("invalid-read-after-terminal", "read_file", {})]);
        }
        if (surfaces.length === 4) {
          const currentWork = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          expect(currentWork).not.toBeNull();
          expect(await fixture.stores.guidedEffectJournal.listForWork(
            currentWork!.workId,
            50,
          )).toContainEqual(expect.objectContaining({ effectId, status: "failed" }));
          expect(surfaces[3]).toContain("record_work_disposition");
          const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
          expect(work).not.toBeNull();
          return toolResponse([toolCall(
            "round-surface-disposition",
            "record_work_disposition",
            {
              work_id: work!.workId,
              disposition: "blocked",
              summary: "The failed test effect is terminal but blocks completion.",
              action_updates: [{ action_key: "create-page", status: "blocked" }],
              remaining_actions: ["Retry the failed page write in a later Turn."],
              next_condition: "A later Turn can safely retry the failed effect.",
            },
          )]);
        }
        expect(surfaces[4]).toContain("record_work_disposition");
        return { text: "facts were refreshed", toolCalls: [] };
      },
    };

    const turn = await admitTurn(
      command,
      fixture.stores.admission,
      fixture.stores.turns,
    );
    const result = await fixture.agent(modelRound).run({
      turn,
      signal: new AbortController().signal,
    });
    expect(surfaces).toHaveLength(5);
    expect(digests[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(digests[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(digests[1]).not.toBe(digests[0]);
    expect(digests[2]).not.toBe(digests[0]);
    expect(digests[2]).not.toBe(digests[1]);
    expect(digests[3]).toBe(digests[1]);
    expect(digests[4]).toBe(digests[3]);
    expect(result.content).toBe("facts were refreshed");

    const disposition = DURABLE_WORK_TOOL_DEFINITIONS.find((tool) =>
      tool.name === "record_work_disposition",
    );
    const failedEffect = fixture.stores.guidedEffectJournal.find(effectId);
    expect(disposition).toBeDefined();
    expect(failedEffect).toMatchObject({ status: "failed" });
    const saturated = await createGuidedRoundToolSurfaceResolver({
      turnId,
      tools: [disposition!],
      requiredToolNames: new Set(),
      toolJournal: fixture.stores.guidedToolJournal,
      durableWork: fixture.stores.durableWork,
      workScope: { turnId, sessionId: command.sessionId },
      effectJournal: {
        listForWork: async () => Array.from({ length: 50 }, (_, index) => ({
          ...failedEffect!,
          effectId: `saturated-terminal-effect-${index}`,
        })),
      },
    })();
    // A full page cannot prove that no >50 effect tail exists, so it fails closed.
    expect(saturated.names.has("record_work_disposition")).toBe(false);
  } finally {
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("feature direct Turn does not gain execution or disposition tools", async () => {
  const previousSurface = process.env.BUTLER_PHASE_TOOL_SURFACE;
  process.env.BUTLER_PHASE_TOOL_SURFACE = "on";
  const fixture = createFixture("guided-direct-round-tool-surface");
  try {
    let names: string[] = [];
    const agent = fixture.agent({
      async runRound(request) {
        names = request.tools.map((tool) => tool.name);
        return { text: "direct", toolCalls: [] };
      },
    });
    await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-direct-round-tool-surface-turn",
        trackingMode: "none",
      }),
      signal: new AbortController().signal,
    });
    for (const name of [
      "run_command", "write_file", "edit_file",
      "replace_work_plan", "record_work_disposition",
    ]) expect(names).not.toContain(name);
  } finally {
    if (previousSurface === undefined) delete process.env.BUTLER_PHASE_TOOL_SURFACE;
    else process.env.BUTLER_PHASE_TOOL_SURFACE = previousSurface;
    fixture.close();
  }
});

test("feature Work schemas project only valid review subjects and Plan action keys", async () => {
  const tools = [...DURABLE_WORK_TOOL_DEFINITIONS, runCommandToolDefinition];
  const resultRef = {
    resultRef: "result:read-page",
    toolCallId: "read-page",
    toolName: "read_file",
    status: "completed" as const,
    originTurnId: "work-surface-turn",
    attachedAt: "2026-08-17T00:00:00.000Z",
  };
  const baseWork: DurableWorkView = {
    workId: "work-surface-work",
    sessionId: "work-surface-session",
    scope: { kind: "session", sessionId: "work-surface-session" },
    origin: { turnId: "work-surface-origin", messageId: "message-origin" },
    objective: "Project valid Work inputs",
    status: "open",
    currentStage: "execution",
    allowedNextStages: ["review"],
    actionProgress: [
      { actionKey: "create-page", status: "active" },
      { actionKey: "verify-page", status: "pending" },
    ],
    currentPlan: {
      planRevisionId: "work-surface-plan",
      revision: 1,
      objective: "Project valid Work inputs",
      actions: [{
        actionKey: "create-page",
        description: "Create the page",
        dependencyKeys: [],
      }, {
        actionKey: "verify-page",
        description: "Verify the page",
        dependencyKeys: ["create-page"],
      }],
      checks: [],
      originTurnId: "work-surface-origin",
      createdAt: "2026-08-17T00:00:00.000Z",
    },
    resultRefs: [resultRef],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
  const snapshotFor = async (work: DurableWorkView) => {
    const durableWork = {
      boundWorkForTurn: async () => work,
      loadContext: async () => ({
        work,
        originalRequest: {
          turnId: "work-surface-origin",
          messageId: "message-origin",
          content: "Project valid Work inputs",
        },
        resultFacts: [],
      }),
    } as unknown as DurableWorkService;
    return createGuidedRoundToolSurfaceResolver({
      turnId: "work-surface-turn",
      tools,
      requiredToolNames: new Set(),
      toolJournal: { list: () => [] },
      durableWork,
      workScope: {
        turnId: "work-surface-turn",
        sessionId: "work-surface-session",
      },
      effectJournal: { listForWork: async () => [] },
    })();
  };

  const execution = await snapshotFor(baseWork);
  const statusOnly = await snapshotFor({
    ...baseWork,
    actionProgress: baseWork.actionProgress.map((action) => ({
      ...action,
      status: "done" as const,
    })),
  });
  const acceptedResult = await snapshotFor({
    ...baseWork,
    currentStage: "validation",
    allowedNextStages: ["planning", "execution", "review", "reporting"],
    latestResultReview: {
      reviewRevisionId: "result-review-current",
      revision: 1,
      subject: "result",
      verdict: "accept",
      summary: "The current result is accepted.",
      corrections: [],
      boundPlanRevisionId: baseWork.currentPlan!.planRevisionId,
      boundResultRefs: [resultRef.resultRef],
      originTurnId: "work-surface-turn",
      createdAt: "2026-08-17T00:01:00.000Z",
    },
  });

  expect(execution.names.has("run_command")).toBe(true);
  expect(statusOnly.digest).toBe(execution.digest);
  expect(acceptedResult.digest).not.toBe(execution.digest);
  const encodedExecution = JSON.stringify(execution.tools);
  const encodedAccepted = JSON.stringify(acceptedResult.tools);
  expect(encodedExecution).toContain('"enum":["plan","result"]');
  expect(encodedExecution).not.toContain('"enum":["plan","result","completion"]');
  expect(encodedAccepted).toContain('"enum":["completion"]');
  expect(encodedExecution.match(/"enum":\["create-page","verify-page"\]/g))
    .toHaveLength(3);
  expect(encodedExecution).not.toContain("evidence_refs");

  const invalid = prepareBtccToolCall({ tools: execution.tools }, {
    id: "unknown-action-key",
    name: "record_work_checkpoint",
    arguments: {
      action_updates: [{ action_key: "invented-action", status: "done" }],
    },
    rawArguments: JSON.stringify({
      action_updates: [{ action_key: "invented-action", status: "done" }],
    }),
  });
  expect(invalid.validationError).toContain("action_key");
});

test("Guided tool discovery hides the retired R2 Work catalog", async () => {
  const fixture = createFixture("guided-work-catalog");
  try {
    let searchResult: unknown;
    let describeResult: unknown;
    const turnId = "turn-work-catalog";
    const calls = [
      toolCall("search-1", "tool_search", {
        query: "work",
        include_disabled: true,
      }),
      toolCall("describe-1", "tool_describe", {
        ids: ["native:list_work_streams", "native:control_work"],
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      (request) => {
        const records = fixture.stores.guidedToolJournal.list(turnId);
        searchResult = records.find((entry) => entry.toolName === "tool_search")?.result;
        describeResult = records.find((entry) => entry.toolName === "tool_describe")?.result;
        expect(messagesWithToolResults(request)).toHaveLength(calls.length);
        return { text: "현재 작업 도구를 확인했습니다.", toolCalls: [] };
      },
    ]));

    await agent.run({
      turn: turnRecord(fixture.root, {
        turnId,
        trackingMode: "local",
      }),
      signal: new AbortController().signal,
    });

    const encodedSearch = JSON.stringify(searchResult);
    expect(encodedSearch).not.toContain("list_work_streams");
    expect(encodedSearch).not.toContain("update_work_stream_state");
    expect(encodedSearch).not.toContain("control_work");
    expect(encodedSearch).not.toContain("project_ledger_work_update");
    expect(encodedSearch).not.toContain("project_ledger_work_complete");
    expect(encodedSearch).not.toContain("complete_project_work");
    expect(describeResult).toMatchObject({
      ok: false,
      descriptions: [],
      missing: [
        { id: "native:list_work_streams", error: "unknown_tool_catalog_id" },
        { id: "native:control_work", error: "unknown_tool_catalog_id" },
      ],
    });
  } finally {
    fixture.close();
  }
});

test("Guided agent replays completed tool results and fences uncertain mutations", async () => {
  const fixture = createFixture("guided-replay");
  try {
    const factPath = join(fixture.root, "fact.txt");
    writeFileSync(factPath, "first value");
    const turn = turnRecord(fixture.root, { turnId: "turn-read-replay" });
    const outputs: unknown[] = [];
    const runRead = async () => {
      const agent = fixture.agent(scriptedModelRound([
        toolResponse([toolCall("read-1", "read_file", { requests: [{ path: "fact.txt" }] })]),
        (request) => {
          outputs.push(fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result);
          expect(messagesWithToolResults(request)).toHaveLength(1);
          return { text: "읽었습니다.", toolCalls: [] };
        },
      ]));
      return agent.run({ turn, signal: new AbortController().signal });
    };
    await runRead();
    writeFileSync(factPath, "second value");
    await runRead();
    expect(outputs[1]).toEqual(outputs[0]);
    expect(JSON.stringify(outputs[1])).toContain("first value");
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);

    const mutationTurn = turnRecord(fixture.root, { turnId: "turn-uncertain-mutation" });
    const mutationArgs = {
      path: "out.txt",
      content: "durable output",
    };
    const rawMutation = JSON.stringify(mutationArgs);
    const callId = digest([
      "btcc-guided-provider-tool-call.v1",
      mutationTurn.turnId,
      "mutation-1",
      "write_file",
      stableJson(mutationArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: mutationTurn.turnId,
      callId,
      toolName: "write_file",
      rawArguments: rawMutation,
      arguments: mutationArgs,
    });
    let uncertain: unknown;
    const mutationAgent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("mutation-1", "write_file", mutationArgs)]),
      (request) => {
        const messages = messagesWithToolResults(request);
        uncertain = toolMessageOutput(
          messages.find((message) => message.toolCallId === "mutation-1"),
        );
        expect(messages).toHaveLength(1);
        return { text: "상태를 먼저 확인해야 합니다.", toolCalls: [] };
      },
    ]));
    const outcome = await mutationAgent.run({
      turn: mutationTurn,
      signal: new AbortController().signal,
    });
    expect(uncertain).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
    });
    expect(existsSync(join(fixture.root, "out.txt"))).toBe(false);
    expect(outcome.route).toBe("assisted");
  } finally {
    fixture.close();
  }
});

test("Guided tool restart reuses a prestarted occurrence after call order changes", async () => {
  const fixture = createFixture("guided-restart-call-order");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "turn-restart-call-order",
    });
    const writeArgs = {
      path: "out.txt",
      content: "durable output",
      overwrite: false,
    };
    const rawWrite = JSON.stringify(writeArgs);
    const prestartedCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "0",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: prestartedCallId,
      toolName: "write_file",
      rawArguments: rawWrite,
      arguments: writeArgs,
    });

    const occurrences: Array<{ toolName: string; occurrenceId?: string }> = [];
    const toolCalls = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: {
        turnId: turn.turnId,
        sessionId: turn.sessionId,
      },
      authorizedNames: new Set(["grep_files", "write_file"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async (call, context) => {
        occurrences.push({
          toolName: call.name,
          occurrenceId: context?.effectOccurrenceId,
        });
        return { ok: true, tool: call.name };
      },
    });

    await toolCalls.executeTool({
      name: "grep_files",
      args: { query: "fact", path: "." },
      rawArguments: JSON.stringify({ query: "fact", path: "." }),
    });
    await toolCalls.executeTool({
      name: "write_file",
      args: {
        overwrite: false,
        content: "durable output",
        path: "out.txt",
      },
      rawArguments:
        '{ "overwrite": false, "content": "durable output", "path": "out.txt" }',
    });
    await toolCalls.executeTool({
      name: "write_file",
      args: writeArgs,
      rawArguments: rawWrite,
    });

    const reorderedCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "1",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    const newOccurrenceCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "2",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    expect(occurrences[1]).toEqual({
      toolName: "write_file",
      occurrenceId: prestartedCallId,
    });
    expect(occurrences[2]).toEqual({
      toolName: "write_file",
      occurrenceId: newOccurrenceCallId,
    });
    expect(fixture.stores.guidedToolJournal.find(prestartedCallId)?.status)
      .toBe("completed");
    expect(fixture.stores.guidedToolJournal.find(reorderedCallId)).toBeNull();
    expect(fixture.stores.guidedToolJournal.find(newOccurrenceCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("completed relation replay repairs a missing prior result without duplicate authority", async () => {
  const fixture = createFixture("guided-relation-replay-repair");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "turn-relation-replay-repair",
    });
    const db = new Database(fixture.dbPath);
    try {
      db.query(`
        INSERT INTO btcc_turns (
          turn_id, session_id, inbox_id, trigger_key, original_message_id,
          original_message, admission_snapshot_ref, model_selection_json,
          context_json, semantic_state, revision, execution_fence
        ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', '{}', '{}', 'admitted', 1, 0)
      `).run(
        turn.turnId,
        turn.sessionId,
        `inbox:${turn.turnId}`,
        `trigger:${turn.turnId}`,
        turn.originalMessageId,
        turn.originalMessage,
      );
    } finally {
      db.close();
    }

    const firstRead = "relation-replay-read-first";
    const secondRead = "relation-replay-read-second";
    for (const [callId, content] of [
      [firstRead, "first"],
      [secondRead, "second"],
    ] as const) {
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "read_file",
        rawArguments: "{}",
        arguments: {},
      });
      fixture.stores.guidedToolJournal.finish({
        callId,
        status: "completed",
        result: { content },
      });
    }

    const relationArgs = { objective: "재생 시 누락 결과를 복구한다" };
    const createExecutor = () => createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["start_work"]),
      visibleNames: new Set(["start_work"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async () => {
        throw new Error("relation replay should stay in the durable Work handler");
      },
    });
    const executeRelation = (executor: ReturnType<typeof createExecutor>) =>
      executor.executeTool({
        name: "start_work",
        args: relationArgs,
        rawArguments: JSON.stringify(relationArgs),
      });

    const firstResult = await executeRelation(createExecutor());
    expect(firstResult).toMatchObject({ ok: true, work: { status: "open" } });
    const firstWork = await fixture.stores.durableWork.boundWorkForTurn(turn.turnId);
    expect(firstWork?.resultRefs.map((result) => result.toolCallId)).toEqual([
      firstRead,
      secondRead,
    ]);

    const missingDb = new Database(fixture.dbPath);
    try {
      missingDb.query(`
        DELETE FROM btcc_guided_work_results WHERE tool_call_id = ?
      `).run(secondRead);
    } finally {
      missingDb.close();
    }
    expect((await fixture.stores.durableWork.boundWorkForTurn(turn.turnId))
      ?.resultRefs.map((result) => result.toolCallId)).toEqual([firstRead]);

    const replayed = await executeRelation(createExecutor());
    expect(replayed).toMatchObject({ ok: true, work: { status: "open" } });
    const repaired = await fixture.stores.durableWork.boundWorkForTurn(turn.turnId);
    expect(repaired?.resultRefs.map((result) => result.toolCallId)).toEqual([
      firstRead,
      secondRead,
    ]);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(3);
    expect((await fixture.stores.durableWork.loadContext({
      turnId: turn.turnId,
      sessionId: turn.sessionId,
    }))?.resultFacts.map((fact) => fact.resultJson)).toEqual([
      { content: "first" },
      { content: "second" },
    ]);
    const countsDb = new Database(fixture.dbPath);
    try {
      expect(countsDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_works
      `).get()?.count).toBe(1);
      expect(countsDb.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings
        WHERE turn_id = ? AND is_current = 1
      `).get(turn.turnId)?.count).toBe(1);
      expect(countsDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_relation_commands
      `).get()?.count).toBe(1);
      expect(countsDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_results
      `).get()?.count).toBe(2);
    } finally {
      countsDb.close();
    }
  } finally {
    fixture.close();
  }
});

test("provider call identity replays one occurrence but admits an identical new command", async () => {
  const fixture = createFixture("guided-provider-occurrence");
  try {
    const occurrences: string[] = [];
    const mutationArgs = {
      command: "printf reviewed >> result.txt",
      summary: "검토된 결과를 작업공간에 기록합니다.",
      state_effect: "mutation",
    };
    const firstTurn = turnRecord(fixture.root, {
      turnId: "guided-provider-occurrence-turn-1",
    });
    const secondTurn = turnRecord(fixture.root, {
      turnId: "guided-provider-occurrence-turn-2",
    });
    const createExecutor = (turn: TurnRecord) => createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["run_command"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async (_call, context) => {
        if (!context?.effectOccurrenceId) {
          throw new Error("Expected a runtime-owned effect occurrence");
        }
        occurrences.push(context.effectOccurrenceId);
        return { ok: true, dispatched: true };
      },
    });
    const execute = (
      executor: ReturnType<typeof createGuidedToolCallExecutor>,
      providerCallId: string,
    ) => executor.executeTool({
      name: "run_command",
      args: mutationArgs,
      rawArguments: JSON.stringify(mutationArgs),
      providerCallId,
    });

    await execute(createExecutor(firstTurn), "provider-call-original");
    expect(occurrences).toHaveLength(1);
    const originalOccurrence = occurrences[0];

    const replayed = await execute(
      createExecutor(firstTurn),
      "provider-call-original",
    );
    expect(replayed).toMatchObject({ ok: true, dispatched: true });
    expect(occurrences).toEqual([originalOccurrence!]);

    await execute(createExecutor(firstTurn), "provider-call-new");
    await execute(createExecutor(secondTurn), "provider-call-original");
    expect(occurrences).toHaveLength(3);
    expect(new Set(occurrences).size).toBe(3);
    expect(fixture.stores.guidedToolJournal.list(firstTurn.turnId)).toHaveLength(2);
    expect(fixture.stores.guidedToolJournal.list(secondTurn.turnId)).toHaveLength(1);
  } finally {
    fixture.close();
  }
});

test("provider v1 progressive mutation records remain authoritative across the identity migration", async () => {
  const fixture = createFixture("guided-provider-v1-progressive-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-progressive-replay-turn",
    });
    const summarylessMutationArgs = {
      command: "printf reviewed >> result.txt",
      state_effect: "mutation",
    };
    const mutationArgs = {
      ...summarylessMutationArgs,
      summary: "검토된 결과를 작업공간에 기록합니다.",
    };
    const calls = [
      { providerCallId: "provider-v1-completed", result: { ok: true, completed: true } },
      { providerCallId: "provider-v1-started" },
    ] as const;
    for (const call of calls) {
      const rawArgs = {
        id: "native:run_command",
        arguments: summarylessMutationArgs,
      };
      const callId = digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        call.providerCallId,
        "tool_call",
        stableJson(rawArgs),
      ].join("\0"));
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "run_command",
        rawArguments: JSON.stringify(rawArgs),
        arguments: summarylessMutationArgs,
      });
      if ("result" in call) {
        fixture.stores.guidedToolJournal.finish({
          callId,
          status: "completed",
          result: call.result,
        });
      }
    }

    const effectOccurrences: string[] = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async (_call, context) => {
        effectOccurrences.push(context?.effectOccurrenceId ?? "");
        return { ok: true, resumed: true };
      },
    });
    const execute = (providerCallId: string) => executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: mutationArgs,
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: mutationArgs,
      }),
      providerCallId,
    });

    await expect(execute("provider-v1-completed")).resolves.toEqual({
      ok: true,
      completed: true,
    });
    await expect(execute("provider-v1-started")).resolves.toEqual({
      ok: true,
      resumed: true,
    });
    expect(effectOccurrences).toHaveLength(1);
    expect(effectOccurrences[0]).toBe(
      digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        "provider-v1-started",
        "tool_call",
        stableJson({ id: "native:run_command", arguments: summarylessMutationArgs }),
      ].join("\0")),
    );
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 responses replay without public activity or duplicate dispatch", async () => {
  const fixture = createFixture("guided-provider-v1-summaryless-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-summaryless-replay-turn",
    });
    const summarylessArgs = {
      command: "printf reviewed >> result.txt",
      state_effect: "mutation",
    };
    const calls = [
      { providerCallId: "provider-summaryless-completed", result: { ok: true, completed: true } },
      { providerCallId: "provider-summaryless-started" },
    ] as const;
    const oldCallIds = new Map<string, string>();
    for (const call of calls) {
      const rawArgs = {
        id: "native:run_command",
        arguments: summarylessArgs,
      };
      const callId = digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        call.providerCallId,
        "tool_call",
        stableJson(rawArgs),
      ].join("\0"));
      oldCallIds.set(call.providerCallId, callId);
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "run_command",
        rawArguments: JSON.stringify(rawArgs),
        arguments: summarylessArgs,
      });
      if ("result" in call) {
        fixture.stores.guidedToolJournal.finish({
          callId,
          status: "completed",
          result: call.result,
        });
      }
    }

    const operations: string[] = [];
    const effectOccurrences: string[] = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async (_call, context) => {
        effectOccurrences.push(context?.effectOccurrenceId ?? "");
        return { ok: true, resumed: true };
      },
    });
    const execute = (providerCallId: string) => executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: summarylessArgs,
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: summarylessArgs,
      }),
      providerCallId,
    });

    await expect(execute("provider-summaryless-completed")).resolves.toEqual({
      ok: true,
      completed: true,
    });
    await expect(execute("provider-summaryless-started")).resolves.toEqual({
      ok: true,
      resumed: true,
    });
    expect(operations).toEqual([]);
    expect(effectOccurrences).toEqual([
      oldCallIds.get("provider-summaryless-started")!,
    ]);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(2);
    expect(fixture.stores.guidedToolJournal.find(
      oldCallIds.get("provider-summaryless-started")!,
    )?.status).toBe("completed");
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 started progressive replay crosses the real bridge schema", async () => {
  const fixture = createFixture("guided-provider-v1-progressive-schema-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-progressive-schema-replay-turn",
    });
    const providerCallId = "provider-progressive-schema-replay";
    const summarylessArgs = {
      command: "printf reviewed >> result.txt",
      state_effect: "mutation",
    };
    const rawBridgeArgs = {
      id: "native:run_command",
      arguments: summarylessArgs,
    };
    const oldCallId = digest([
      "btcc-guided-provider-tool-call.v1",
      turn.turnId,
      providerCallId,
      "tool_call",
      stableJson(rawBridgeArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: oldCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(rawBridgeArgs),
      arguments: summarylessArgs,
    });

    const operations: string[] = [];
    const dispatched: Array<{
      name: string;
      args: Record<string, unknown>;
      effectOccurrenceId?: string;
    }> = [];
    const bridge = createToolCallToolHandler({
      butlerData: fixture.root,
      currentToolNames: ["run_command"],
      nativeToolDefinitions: [runCommandToolDefinition],
      dispatchTool: async (call, context) => {
        dispatched.push({
          name: call.name,
          args: call.args,
          ...(context?.effectOccurrenceId
            ? { effectOccurrenceId: context.effectOccurrenceId }
            : {}),
        });
        return { ok: true, exit_code: 0 };
      },
    });
    const executeButlerTool: ContextualButlerToolExecutor = (call, context) =>
      bridge({ args: call.args, rawArguments: call.rawArguments }, context);
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool,
    });

    const result = await executor.executeTool({
      name: "tool_call",
      args: rawBridgeArgs,
      rawArguments: JSON.stringify(rawBridgeArgs),
      providerCallId,
    });

    expect(result).toMatchObject({
      ok: true,
      exit_code: 0,
      bridge_invocation: {
        id: "native:run_command",
        provider: "native",
        affordance: "native_tool",
      },
    });
    expect(result).not.toHaveProperty("summary");
    expect(JSON.stringify(result)).not.toContain("previously started");
    expect(operations).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      name: "run_command",
      effectOccurrenceId: oldCallId,
      args: {
        command: summarylessArgs.command,
        state_effect: summarylessArgs.state_effect,
        summary: expect.any(String),
      },
    });
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);
    expect(fixture.stores.guidedToolJournal.find(oldCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("v2 exact records win when a provider v1 alias points at another replay", async () => {
  const fixture = createFixture("guided-provider-v2-v1-conflict");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v2-v1-conflict-turn",
    });
    const providerCallId = "provider-v2-v1-conflict";
    const args = {
      id: "native:run_command",
      arguments: {
        command: "pwd",
        summary: "현재 작업공간 위치를 확인합니다.",
        state_effect: "read_only",
      },
    };
    const exactCallId = guidedToolOccurrence({
      turnId: turn.turnId,
      callIndex: 0,
      providerCallId,
      name: "tool_call",
      args,
    }).callId;
    const legacyCallId = digest([
      "btcc-guided-provider-tool-call.v1",
      turn.turnId,
      providerCallId,
      "tool_call",
      stableJson(args),
    ].join("\0"));
    const legacyArgs = args.arguments;
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: legacyCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(args),
      arguments: legacyArgs,
    });
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: exactCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(args),
      arguments: legacyArgs,
    });
    fixture.stores.guidedToolJournal.finish({
      callId: exactCallId,
      status: "completed",
      result: { ok: true, source: "v2-exact" },
    });

    let dispatches = 0;
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async () => {
        dispatches += 1;
        return { ok: true, source: "dispatch" };
      },
    });

    await expect(executor.executeTool({
      name: "tool_call",
      args,
      rawArguments: JSON.stringify(args),
      providerCallId,
    })).resolves.toEqual({ ok: true, source: "v2-exact" });
    expect(dispatches).toBe(0);
    expect(fixture.stores.guidedToolJournal.find(exactCallId)?.status)
      .toBe("completed");
    expect(fixture.stores.guidedToolJournal.find(legacyCallId)?.status)
      .toBe("started");
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 started direct replay injects only an execution summary", async () => {
  const fixture = createFixture("guided-provider-v1-direct-summary-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-direct-summary-replay-turn",
    });
    const providerCallId = "provider-direct-summary-replay";
    const summarylessArgs = {
      command: "pwd",
      state_effect: "read_only",
    };
    const oldCallId = digest([
      "btcc-guided-provider-tool-call.v1",
      turn.turnId,
      providerCallId,
      "run_command",
      stableJson(summarylessArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: oldCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(summarylessArgs),
      arguments: summarylessArgs,
    });

    const dispatched: Array<{
      args: Record<string, unknown>;
      effectOccurrenceId?: string;
    }> = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["run_command"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async (call, context) => {
        dispatched.push({
          args: call.args,
          ...(context?.effectOccurrenceId
            ? { effectOccurrenceId: context.effectOccurrenceId }
            : {}),
        });
        return { ok: true, direct: true };
      },
    });

    const result = await executor.executeTool({
      name: "run_command",
      args: summarylessArgs,
      rawArguments: JSON.stringify(summarylessArgs),
      providerCallId,
    });

    expect(result).toEqual({ ok: true, direct: true });
    expect(result).not.toHaveProperty("summary");
    expect(dispatched).toEqual([{
      args: {
        ...summarylessArgs,
        summary: expect.any(String),
      },
      effectOccurrenceId: oldCallId,
    }]);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);
    expect(fixture.stores.guidedToolJournal.find(oldCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 failed and cancelled records remain terminal", async () => {
  const fixture = createFixture("guided-provider-v1-terminal-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-terminal-replay-turn",
    });
    const summarylessArgs = {
      command: "pwd",
      state_effect: "read_only",
    };
    const calls = [
      { providerCallId: "provider-v1-failed", status: "failed" as const },
      { providerCallId: "provider-v1-cancelled", status: "cancelled" as const },
    ];
    const callIds = new Map<string, string>();
    for (const call of calls) {
      const callId = digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        call.providerCallId,
        "run_command",
        stableJson(summarylessArgs),
      ].join("\0"));
      callIds.set(call.providerCallId, callId);
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "run_command",
        rawArguments: JSON.stringify(summarylessArgs),
        arguments: summarylessArgs,
      });
      fixture.stores.guidedToolJournal.finish({
        callId,
        status: call.status,
        ...(call.status === "cancelled" ? { errorCode: "cancelled" } : {}),
      });
    }

    const operations: string[] = [];
    let dispatches = 0;
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["run_command"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async () => {
        dispatches += 1;
        return { ok: true };
      },
    });

    for (const call of calls) {
      const result = await executor.executeTool({
        name: "run_command",
        args: summarylessArgs,
        rawArguments: JSON.stringify(summarylessArgs),
        providerCallId: call.providerCallId,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: call.status === "cancelled"
            ? "prior_tool_call_cancelled"
            : "prior_tool_call_failed",
        },
      });
    }
    expect(operations).toEqual([]);
    expect(dispatches).toBe(0);
    for (const call of calls) {
      expect(fixture.stores.guidedToolJournal.find(
        callIds.get(call.providerCallId)!,
      )?.status).toBe(call.status);
    }
  } finally {
    fixture.close();
  }
});

test("fresh progressive tool execution publishes its nested command summary", async () => {
  const fixture = createFixture("guided-progressive-command-publish");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-progressive-command-publish-turn",
    });
    const summary = "중첩 명령 요약을 공개 진행 상태에 사용합니다.";
    const operations: Array<{ status: string; inputLabel?: string }> = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push({
            status: update.status,
            ...(update.inputLabel !== undefined
              ? { inputLabel: update.inputLabel }
              : {}),
          });
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async () => ({ ok: true, exit_code: 0 }),
    });

    await executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: { command: "pwd", summary },
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: { command: "pwd", summary },
      }),
    });

    expect(operations).toEqual([
      { status: "started", inputLabel: summary },
      { status: "completed", inputLabel: summary },
    ]);
  } finally {
    fixture.close();
  }
});

test("progressive run_command without summary returns validation before public progress", async () => {
  const fixture = createFixture("guided-progressive-command-missing-summary");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-progressive-command-missing-summary-turn",
    });
    const operations: Array<{ status: string }> = [];
    const activities: Array<{ title: string; summary: string }> = [];
    const activity = createGuidedActivityProjection({
      turnId: turn.turnId,
      managedInitially: true,
      progress: {
        stateChanged: async () => {},
        phaseActivityChanged(update) {
          activities.push({ title: update.title, summary: update.summary });
        },
      },
    });
    let dispatches = 0;
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      activity,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push({ status: update.status });
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async () => {
        dispatches += 1;
        return { ok: true };
      },
    });

    const result = await executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: { command: "pwd", state_effect: "read_only" },
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: { command: "pwd", state_effect: "read_only" },
      }),
      providerCallId: "provider-fresh-summaryless",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });
    expect(operations).toEqual([]);
    expect(activities).toEqual([]);
    expect(dispatches).toBe(0);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toEqual([]);
  } finally {
    fixture.close();
  }
});

test("run_command rejects a sanitizer-empty public summary before journal or dispatch", async () => {
  const fixture = createFixture("guided-command-unsafe-summary");
  try {
    const executeCases = [
      {
        turnId: "guided-command-unsafe-summary-direct",
        name: "run_command",
        args: {
          command: "pwd",
          summary: "Inspect /Users/alice/private/report.json",
        },
        visibleName: "run_command",
      },
      {
        turnId: "guided-command-unsafe-summary-progressive",
        name: "tool_call",
        args: {
          id: "native:run_command",
          arguments: {
            command: "pwd",
            summary: "Inspect /Users/alice/private/report.json",
          },
        },
        visibleName: "tool_call",
      },
    ] as const;
    for (const input of executeCases) {
      const turn = turnRecord(fixture.root, { turnId: input.turnId });
      let dispatches = 0;
      const executor = createGuidedToolCallExecutor({
        turn,
        signal: new AbortController().signal,
        workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
        authorizedNames: new Set([input.visibleName]),
        describedToolIds: new Set(),
        durableWork: fixture.stores.durableWork,
        toolJournal: fixture.stores.guidedToolJournal,
        workspacePath: () => fixture.root,
        butlerData: fixture.root,
        executeButlerTool: async () => {
          dispatches += 1;
          return { ok: true };
        },
      });
      const result = await executor.executeTool({
        name: input.name,
        args: input.args,
        rawArguments: JSON.stringify(input.args),
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_tool_arguments",
          path: "$.summary",
        },
      });
      expect(dispatches).toBe(0);
      expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toEqual([]);
    }
  } finally {
    fixture.close();
  }
});

test("Guided agent turns provider failure into one fact-based final report", async () => {
  const fixture = createFixture("guided-fallback");
  try {
    writeFileSync(join(fixture.root, "settings.json"), '{"enabled":true}\n');
    let calls = 0;
    const fallbackAgent = fixture.agent(scriptedModelRound([
      () => {
        calls += 1;
        return toolResponse([
          toolCall("read-1", "read_file", { requests: [{ path: "settings.json" }] }),
        ], "설정 파일을 확인하겠습니다.");
      },
      () => {
        calls += 1;
        throw knownProviderFailure("provider disconnected after usable text");
      },
    ]));
    const outcome = await fallbackAgent.run({
      turn: turnRecord(fixture.root),
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({
      route: "assisted",
      content: "현재 요청을 처리했지만 답변 생성을 마치지 못했습니다.\n현재 Turn에서 확인된 내용: 검증된 소스 근거를 확인했습니다.\n완료되지 않은 작업을 완료로 처리하지 않았습니다.",
    });
    expect(calls).toBe(2);

    const commandAgent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("pwd-1", "run_command", {
        command: "pwd",
        summary: "현재 작업공간 위치를 확인합니다.",
        state_effect: "read_only",
      })]),
      { text: "폴더를 확인했습니다.", toolCalls: [] },
    ]));
    expect((await commandAgent.run({
      turn: turnRecord(fixture.root, { turnId: "turn-command" }),
      signal: new AbortController().signal,
    })).route).toBe("assisted");
  } finally {
    fixture.close();
  }
});

test("unbound capture fallback never inherits an unrelated candidate Work", async () => {
  const fixture = createFixture("guided-fallback-candidate-isolation");
  try {
    writeFileSync(join(fixture.root, "capture.txt"), "current capture evidence\n");
    const candidateTurnId = "candidate-monitoring-turn";
    let candidateWorkId = "";
    let candidateCalls = 0;
    const candidateRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: fixture.agent({
        async runRound(request) {
          candidateCalls += 1;
          if (candidateCalls === 1) {
            return toolResponse([toolCall("candidate-start", "start_work", {
              objective: "오래된 모니터링 Work 목표",
            })]);
          }
          if (candidateCalls === 2) {
            const output = toolMessageOutput(
              messagesWithToolResults(request).at(-1),
            ) as { work?: { work_id?: string } };
            candidateWorkId = output.work?.work_id ?? "";
            return toolResponse([toolCall("candidate-plan", "replace_work_plan", {
              objective: "오래된 모니터링 Work 목표",
              actions: [{
                action_key: "monitor",
                description: "오래된 모니터링을 수행합니다",
                dependency_keys: [],
              }],
              checks: ["오래된 모니터링을 확인합니다"],
            })]);
          }
          if (candidateCalls === 3) {
            return toolResponse([toolCall("candidate-checkpoint", "record_work_checkpoint", {
              next_stage: "execution",
              action_updates: [{ action_key: "monitor", status: "active" }],
              public_summary: "오래된 모니터링 체크포인트가 남아 있습니다.",
              next_step: "오래된 모니터링 다음 단계를 수행합니다.",
            })]);
          }
          if (candidateCalls === 4) {
            return toolResponse([toolCall("candidate-disposition", "record_work_disposition", {
              work_id: candidateWorkId,
              disposition: "open",
              summary: "오래된 모니터링을 계속합니다.",
              remaining_actions: ["오래된 모니터링을 계속합니다"],
            })]);
          }
          return { text: "모니터링 기록을 저장했습니다.", toolCalls: [] };
        },
      }),
    });
    await candidateRuntime.runTurn(localRunCommand(fixture.root, candidateTurnId));
    const candidate = await fixture.stores.durableWork.boundWorkForTurn(candidateTurnId);
    expect(candidate).toMatchObject({
      status: "open",
      latestDisposition: {
        summary: "오래된 모니터링을 계속합니다.",
        remainingActions: ["오래된 모니터링을 계속합니다"],
      },
    });

    const captureTurnId = "unbound-capture-turn";
    const captureRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: fixture.agent(scriptedModelRound([
        toolResponse([toolCall("capture-read", "read_file", {
          path: "capture.txt",
        })]),
        () => { throw knownProviderFailure("capture model disconnected"); },
      ])),
    });

    const outcome = await captureRuntime.runTurn(localRunCommand(fixture.root, captureTurnId));

    expect(outcome.kind).toBe("delivered");
    if (outcome.kind === "delivered") {
      expect(outcome.content).not.toContain("오래된 모니터링");
      expect(outcome.content).not.toContain("오래된 모니터링 체크포인트");
      expect(outcome.content).not.toContain(candidateWorkId);
    }
    expect(await fixture.stores.durableWork.boundWorkForTurn(captureTurnId)).toBeNull();
  } finally {
    fixture.close();
  }
});

test("whole-goal sequence preserves explicit relation across restart and exhaustion", async () => {
  const fixture = createFixture("guided-whole-goal-sequence");
  let currentStores = fixture.stores;
  const createAgent = (modelRound: ModelRoundPort) => createProductionGuidedTurnAgent({
    butlerHome: fixture.root,
    butlerData: fixture.root,
    phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
    contextDocuments: currentStores.contextDocuments,
    toolJournal: currentStores.guidedToolJournal,
    effectJournal: currentStores.guidedEffectJournal,
    durableWork: currentStores.durableWork,
    modelRound,
  });
  const createRuntime = (turnId: string, modelRound: ModelRoundPort) =>
    createGuidedTurnRuntime({
      admission: currentStores.admission,
      turns: currentStores.turns,
      messages: currentStores.messages,
      committedSuccessorReadiness: currentStores.committedSuccessorReadiness,
      agent: createAgent(modelRound),
    }).runTurn(localRunCommand(fixture.root, turnId));
  const restart = () => {
    currentStores.close();
    currentStores = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId: "guided-whole-goal-sequence",
      storageProfile: "ephemeral",
    });
  };

  try {
    writeFileSync(join(fixture.root, "monitoring-evidence.txt"), "baseline confirmed\n");
    let monitoringWorkId = "";
    let monitoringCalls = 0;
    const monitoringResult = await createRuntime(
      "whole-goal-monitoring-start",
      {
        async runRound(request) {
          monitoringCalls += 1;
          if (monitoringCalls === 1) {
            return toolResponse([toolCall("monitor-start", "start_work", {
              objective: "안전한 모니터링 기준선을 확인합니다",
            })]);
          }
          if (monitoringCalls === 2) {
            const output = toolMessageOutput(
              messagesWithToolResults(request).at(-1),
            ) as { work?: { work_id?: string } };
            monitoringWorkId = output.work?.work_id ?? "";
            return toolResponse([toolCall("monitor-plan", "replace_work_plan", {
              objective: "안전한 모니터링 기준선을 확인합니다",
              actions: [{
                action_key: "monitor-baseline",
                description: "안전한 기준선을 확인합니다",
                dependency_keys: [],
              }],
              checks: ["기준선 근거를 확인합니다"],
            })]);
          }
          if (monitoringCalls === 3) {
            return toolResponse([toolCall("monitor-checkpoint", "record_work_checkpoint", {
              next_stage: "execution",
              action_updates: [{ action_key: "monitor-baseline", status: "active" }],
              public_summary: "기준선 확인을 진행합니다.",
              next_step: "기준선 확인을 마칩니다.",
            })]);
          }
          if (monitoringCalls === 4) {
            return toolResponse([toolCall("monitor-open", "record_work_disposition", {
              work_id: monitoringWorkId,
              disposition: "open",
              summary: "기준선 확인을 계속합니다.",
              remaining_actions: ["기준선 확인을 마칩니다"],
            })]);
          }
          return { text: "모니터링 기준선을 계속 확인합니다.", toolCalls: [] };
        },
      },
    );
    expect(monitoringResult).toMatchObject({
      kind: "delivered",
      content: "모니터링 기준선을 계속 확인합니다.",
    });
    expect(monitoringWorkId).toMatch(/^guided-work-/);
    expect(await currentStores.durableWork.boundWorkForTurn(
      "whole-goal-monitoring-start",
    )).toMatchObject({
      workId: monitoringWorkId,
      status: "open",
      latestDisposition: { disposition: "open" },
    });

    restart();
    let monitoringContinuationCalls = 0;
    const completedMonitoring = await createRuntime(
      "whole-goal-monitoring-complete",
      {
        async runRound(_request) {
          monitoringContinuationCalls += 1;
          if (monitoringContinuationCalls === 1) {
            return toolResponse([toolCall("monitor-continue", "continue_work", {
              work_id: monitoringWorkId,
            })]);
          }
          if (monitoringContinuationCalls === 2) {
            return toolResponse([toolCall("monitor-evidence", "read_file", {
              path: "monitoring-evidence.txt",
            })]);
          }
          if (monitoringContinuationCalls === 3) {
            return toolResponse([toolCall("monitor-complete", "record_work_disposition", {
              work_id: monitoringWorkId,
              disposition: "completed",
              summary: "기준선 확인을 완료했습니다.",
              action_updates: [{
                action_key: "monitor-baseline",
                status: "done",
                note: "기준선 근거를 확인했습니다.",
              }],
            })]);
          }
          return { text: "모니터링 기준선 확인을 마쳤습니다.", toolCalls: [] };
        },
      },
    );
    expect(completedMonitoring).toMatchObject({
      kind: "delivered",
      content: "모니터링 기준선 확인을 마쳤습니다.",
    });
    expect(await currentStores.durableWork.boundWorkForTurn(
      "whole-goal-monitoring-complete",
    )).toMatchObject({
      workId: monitoringWorkId,
      status: "completed",
      latestDisposition: {
        disposition: "completed",
        originTurnId: "whole-goal-monitoring-complete",
      },
    });

    writeFileSync(join(fixture.root, "capture-evidence.txt"), "capture evidence");
    restart();
    let captureWorkId = "";
    let captureCalls = 0;
    const exhaustedCapture = await createRuntime(
      "whole-goal-capture-start",
      {
        async runRound(_request) {
          captureCalls += 1;
          if (captureCalls === 1) {
            return toolResponse([toolCall("capture-read", "read_file", {
              path: "capture-evidence.txt",
            })]);
          }
          if (captureCalls === 2) {
            return toolResponse([toolCall("capture-start", "start_work", {
              objective: "캡처 하드닝 근거를 정리합니다",
            })]);
          }
          throw knownProviderFailure("capture provider exhausted after Work selection");
        },
      },
    );
    expect(exhaustedCapture.kind).toBe("delivered");
    if (exhaustedCapture.kind === "delivered") {
      expect(exhaustedCapture.content).not.toContain("안전한 모니터링 기준선");
      expect(exhaustedCapture.content).not.toContain(monitoringWorkId);
      expect(exhaustedCapture.content).toContain("현재 요청을 처리했지만 답변 생성을 마치지 못했습니다.");
    }
    captureWorkId = (await currentStores.durableWork.boundWorkForTurn(
      "whole-goal-capture-start",
    ))?.workId ?? "";
    expect(captureWorkId).toMatch(/^guided-work-/);
    expect(captureWorkId).not.toBe(monitoringWorkId);

    restart();
    let captureContinuationCalls = 0;
    const captureFollowup = await createRuntime(
      "whole-goal-capture-followup",
      {
        async runRound(_request) {
          captureContinuationCalls += 1;
          if (captureContinuationCalls === 1) {
            return toolResponse([toolCall("capture-continue", "continue_work", {
              work_id: captureWorkId,
            })]);
          }
          if (captureContinuationCalls === 2) {
            return toolResponse([toolCall("capture-plan", "replace_work_plan", {
              objective: "캡처 하드닝 근거를 정리합니다",
              actions: [{
                action_key: "capture-hardening",
                description: "캡처 하드닝 근거를 정리합니다",
                dependency_keys: [],
              }],
              checks: ["현재 변경 근거를 확인합니다"],
            })]);
          }
          if (captureContinuationCalls === 3) {
            return toolResponse([toolCall("capture-checkpoint", "record_work_checkpoint", {
              next_stage: "execution",
              action_updates: [{ action_key: "capture-hardening", status: "active" }],
              public_summary: "캡처 하드닝 근거를 정리하는 중입니다.",
              next_step: "현재 변경 근거를 확인합니다.",
            })]);
          }
          if (captureContinuationCalls === 4) {
            return toolResponse([toolCall("capture-open", "record_work_disposition", {
              work_id: captureWorkId,
              disposition: "open",
              summary: "캡처 하드닝 근거를 계속 정리합니다.",
              remaining_actions: ["현재 변경 근거를 확인합니다"],
            })]);
          }
          return { text: "캡처 하드닝 근거를 계속 정리합니다.", toolCalls: [] };
        },
      },
    );
    expect(captureFollowup).toMatchObject({
      kind: "delivered",
      content: "캡처 하드닝 근거를 계속 정리합니다.",
    });
    expect(await currentStores.durableWork.boundWorkForTurn(
      "whole-goal-capture-followup",
    )).toMatchObject({
      workId: captureWorkId,
      status: "open",
      latestDisposition: {
        disposition: "open",
        originTurnId: "whole-goal-capture-followup",
      },
    });
    expect(await currentStores.durableWork.boundWorkForTurn(
      "whole-goal-monitoring-complete",
    )).toMatchObject({
      workId: monitoringWorkId,
      status: "completed",
    });
  } finally {
    currentStores.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue_work does not republish an old Plan into fallback progress", async () => {
  const fixture = createFixture("guided-fallback-continue-old-plan");
  try {
    const originTurnId = "old-plan-origin-turn";
    let workId = "";
    let originCalls = 0;
    const originRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: fixture.agent({
        async runRound(request) {
          originCalls += 1;
          if (originCalls === 1) {
            return toolResponse([toolCall("old-start", "start_work", {
              objective: "오래된 Plan 목표",
            })]);
          }
          if (originCalls === 2) {
            const output = toolMessageOutput(
              messagesWithToolResults(request).at(-1),
            ) as { work?: { work_id?: string } };
            workId = output.work?.work_id ?? "";
            return toolResponse([toolCall("old-plan", "replace_work_plan", {
              objective: "오래된 Plan 목표",
              actions: [{
                action_key: "old-action",
                description: "오래된 Plan 결과",
                dependency_keys: [],
              }],
              checks: ["오래된 Plan 검증"],
            })]);
          }
          if (originCalls === 3) {
            return toolResponse([toolCall("old-checkpoint", "record_work_checkpoint", {
              next_stage: "execution",
              action_updates: [{ action_key: "old-action", status: "active" }],
              public_summary: "오래된 Plan 체크포인트",
              next_step: "오래된 Plan 다음 단계",
            })]);
          }
          if (originCalls === 4) {
            return toolResponse([toolCall("old-open", "record_work_disposition", {
              work_id: workId,
              disposition: "open",
              summary: "오래된 Plan을 저장했습니다.",
              remaining_actions: ["오래된 Plan 결과"],
            })]);
          }
          return { text: "오래된 Plan을 저장했습니다.", toolCalls: [] };
        },
      }),
    });
    await originRuntime.runTurn(localRunCommand(fixture.root, originTurnId));
    expect(workId).toMatch(/^guided-work-/);

    const continuationTurnId = "new-continue-fallback-turn";
    const continuationRuntime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent: fixture.agent(scriptedModelRound([
        toolResponse([toolCall("continue-old", "continue_work", {
          work_id: workId,
        })]),
        () => { throw knownProviderFailure("continuation model disconnected"); },
      ])),
    });

    const outcome = await continuationRuntime.runTurn(
      localRunCommand(fixture.root, continuationTurnId),
    );
    expect(outcome.kind).toBe("delivered");
    if (outcome.kind === "delivered") {
      expect(outcome.content).not.toContain("오래된 Plan");
      expect(outcome.content).not.toContain(workId);
      expect(outcome.content).toContain("현재 요청을 완료하지 못했고 답변 생성을 마치지 못했습니다.");
    }
  } finally {
    fixture.close();
  }
});

test("operational progress capture requires current origin and revision", async () => {
  const forwarded: string[] = [];
  const capture = createGuidedOperationalProgressCapture({
    stateChanged() {},
    workProgressChanged(update) {
      forwarded.push(update.tasks[0]?.taskOutcome ?? "");
    },
  });
  await capture.observer?.workProgressChanged?.({
    turnId: "turn-progress-current",
    turnRevision: 3,
    originTurnId: "turn-progress-old",
    sourceRevision: 9,
    programId: "old-work",
    tasks: [{
      taskId: "old-task",
      taskTitle: "old Plan title",
      taskDescription: "old Plan description",
      taskOutcome: "old Plan outcome",
      taskOrder: 0,
      taskState: "active",
      workId: "old-work",
      workTitle: "old Work",
      workState: "active",
    }],
  });
  await capture.observer?.workProgressChanged?.({
    turnId: "turn-progress-current",
    turnRevision: 3,
    originTurnId: "turn-progress-current",
    sourceRevision: 2,
    programId: "current-work",
    tasks: [{
      taskId: "current-task",
      taskTitle: "current Plan title",
      taskDescription: "current Plan description",
      taskOutcome: "current Plan outcome",
      taskOrder: 0,
      taskState: "active",
      workId: "current-work",
      workTitle: "current Work",
      workState: "active",
    }],
  });
  await capture.observer?.phaseActivityChanged?.({
    turnId: "turn-progress-current",
    semanticState: "running",
    activityId: "activity-old",
    originTurnId: "turn-progress-old",
    sourceRevision: 1,
    title: "old phase",
    summary: "old phase summary",
    nextStep: "old phase next",
  });

  expect(forwarded).toEqual(["old Plan outcome", "current Plan outcome"]);
  expect(capture.facts()).toEqual(["current Plan outcome"]);
});

test("Guided agent preserves the caller signal without a whole-turn deadline", async () => {
  const fixture = createFixture("guided-caller-boundary");
  try {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        observedSignal = request.signal;
        return { text: "요청을 정상적으로 마쳤습니다.", toolCalls: [] };
      },
    ]));

    const outcome = await agent.run({
      turn: turnRecord(fixture.root, { turnId: "guided-caller-boundary-turn" }),
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(false);
    expect(outcome).toEqual({
      route: "direct",
      content: "요청을 정상적으로 마쳤습니다.",
    });
  } finally {
    fixture.close();
  }
});

test("Guided model never sees a whole-turn remaining-time field", async () => {
  const fixture = createFixture("guided-turn-time-context");
  try {
    writeFileSync(join(fixture.root, "settings.json"), '{"enabled":true}\n');
    let modelResult: Record<string, unknown> | undefined;
    let modelInstructions = "";
    const turn = turnRecord(fixture.root, { turnId: "guided-turn-time-context" });
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("read-1", "read_file", { requests: [{ path: "settings.json" }] })]),
      (request) => {
        modelInstructions = request.instructions ?? "";
        const toolMessage = messagesWithToolResults(request)[0];
        const payload = JSON.parse(toolMessage?.content ?? "{}") as {
          output?: Record<string, unknown>;
        };
        modelResult = payload.output;
        return { text: "확인했습니다.", toolCalls: [] };
      },
    ]));

    await agent.run({ turn, signal: new AbortController().signal });

    expect(modelResult).toBeDefined();
    expect(modelResult).not.toHaveProperty("turn_time_remaining_seconds");
    expect(modelInstructions).not.toContain("turn_time_remaining_seconds");
    const persisted = fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result;
    expect(persisted).toBeDefined();
    expect(persisted as Record<string, unknown>)
      .not.toHaveProperty("turn_time_remaining_seconds");
  } finally {
    fixture.close();
  }
});

test("Managed Work remains in the semantic loop while a model round is still running", async () => {
  const fixture = createFixture("guided-long-managed-round");
  let releaseRound = () => {};
  try {
    let roundStarted!: () => void;
    let settled = false;
    const roundRunning = new Promise<void>((resolve) => {
      roundStarted = resolve;
    });
    const delayedResult = new Promise<ModelRoundResult>((resolve) => {
      releaseRound = () => resolve({
        text: "긴 Managed Work를 끝까지 완료했습니다.",
        toolCalls: [],
      });
    });
    const agent = fixture.agent(scriptedModelRound([
      () => toolResponse([toolCall("long-plan-1", "replace_work_plan", {
        objective: "Finish the long Managed Work",
        actions: [{
          action_key: "finish-work",
          description: "Finish the requested Managed Work",
        }],
        checks: ["The requested Managed Work is complete"],
      })]),
      () => {
        roundStarted();
        return delayedResult;
      },
    ]));
    const running = agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-long-managed-round-turn",
        trackingMode: "local",
      }),
      signal: new AbortController().signal,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await roundRunning;
    expect(settled).toBe(false);
    releaseRound();

    await expect(running).resolves.toEqual({
      route: "managed",
      content: "긴 Managed Work를 끝까지 완료했습니다.",
    });
  } finally {
    releaseRound?.();
    fixture.close();
  }
});

test("operational fallback uses only current-Turn safe facts before updated Work", () => {
  const turnId = "turn-operational-facts";
  const staleWork: DurableWorkView = {
    workId: "guided-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sessionId: "session-operational-facts",
    scope: { kind: "session", sessionId: "session-operational-facts" },
    origin: { turnId: "turn-older", messageId: "message-older" },
    objective: "오래된 작업 목표",
    status: "open",
    currentStage: "execution",
    allowedNextStages: ["review"],
    actionProgress: [],
    latestCheckpoint: {
      checkpointRevisionId: "checkpoint-older",
      revision: 1,
      planRevisionId: "plan-older",
      stage: "execution",
      actionProgress: [],
      publicSummary: "오래된 체크포인트 내용",
      nextStep: "오래된 다음 단계",
      referencedResultRefs: [],
      originTurnId: "turn-older",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    effectBlockers: [{
      blockerId: "blocker-older",
      sourceTurnId: "turn-older",
      capability: "workspace.file",
      target: "workspace:old.txt",
      detail: "old blocker",
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
    resultRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  expect(operationalWorkFacts(staleWork, turnId)).toBeUndefined();

  const currentTool = {
    callId: "safe-fact-call",
    toolName: "read_file",
    rawArguments: "{\"path\":\"secret.txt\"}",
    arguments: { path: "secret.txt" },
    status: "completed" as const,
    result: {
      ok: true,
      evidence_capability_receipts: [{
        receipt_id: "evidence-current",
        schema_version: "evidence-capability.v1",
        producer: { kind: "tool", name: "read_file" },
        capability: "source_verified",
        evidence_kind: "source_page",
        maturity: "verified",
        confidence: 1,
        verified: true,
        summary: "현재 파일 상태를 확인했습니다.",
        references: [],
        limitations: [],
        created_at: "2026-08-01T00:00:00.000Z",
      }],
      content: "RAW PRIVATE TOOL OUTPUT",
      evidence_receipts: [{ summary: "현재 공개 증거를 확인했습니다." }],
      effect_receipt: { receipt_id: "receipt-current" },
    },
  };
  const appliedEffect = {
    effectId: "effect-current",
    receiptId: "receipt-current",
    status: "applied",
    receipt: { receiptId: "receipt-current" },
  } as unknown as import(
    "../../packages/butler-agent/src/agent/btcc/effects/index.ts"
  ).GuidedEffectJournalRecord;
  const oldEffect = {
    effectId: "effect-old",
    receiptId: "receipt-old",
    status: "applied",
  } as unknown as import(
    "../../packages/butler-agent/src/agent/btcc/effects/index.ts"
  ).GuidedEffectJournalRecord;
  const secondAppliedEffect = {
    effectId: "effect-current-2",
    receiptId: "receipt-current-2",
    status: "applied",
    receipt: { receiptId: "receipt-current-2" },
  } as unknown as import(
    "../../packages/butler-agent/src/agent/btcc/effects/index.ts"
  ).GuidedEffectJournalRecord;
  const pendingEffect = {
    effectId: "effect-pending",
    receiptId: "receipt-pending",
    status: "pending",
  } as unknown as import(
    "../../packages/butler-agent/src/agent/btcc/effects/index.ts"
  ).GuidedEffectJournalRecord;
  expect(currentTurnEffectRecords([currentTool], [appliedEffect, oldEffect]))
    .toEqual([appliedEffect]);

  const fallback = guidedOperationalFallback({
    originalRequest: "현재 상태를 확인해 주세요.",
    responseLanguage: "ko",
    work: staleWork,
    toolCalls: [currentTool],
    effects: [appliedEffect, secondAppliedEffect, pendingEffect],
    currentTurnProgress: ["현재 공개 진행을 확인했습니다.", "Steward 내부 상태"],
  });
  expect(fallback).toContain("검증된 소스 근거를 확인했습니다.");
  expect(fallback).not.toContain("현재 파일 상태를 확인했습니다.");
  expect(fallback).not.toContain("현재 공개 증거를 확인했습니다.");
  expect(fallback).toContain("현재 Turn의 변경 결과를 확인했습니다.");
  expect(fallback.match(/현재 Turn의 변경 결과를 확인했습니다\./gu)).toHaveLength(1);
  expect(fallback).toContain("현재 진행 내용: 현재 공개 진행을 확인했습니다.");
  expect(fallback).not.toContain("RAW PRIVATE TOOL OUTPUT");
  expect(fallback).not.toContain("오래된 체크포인트 내용");
  expect(fallback).not.toContain("오래된 다음 단계");
  expect(fallback).not.toContain(staleWork.workId);
  expect(fallback).not.toContain("Steward");
});

test("bound Work becomes fallback-eligible only after a current-Turn material update", () => {
  const turnId = "turn-current-work-facts";
  const staleCheckpoint = {
    checkpointRevisionId: "checkpoint-stale",
    revision: 1,
    planRevisionId: "plan-stale",
    stage: "execution" as const,
    actionProgress: [],
    publicSummary: "저장된 이전 진행 내용",
    nextStep: "이전 다음 단계",
    referencedResultRefs: [],
    originTurnId: "turn-before",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const work: DurableWorkView = {
    workId: "guided-work-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sessionId: "session-current-work-facts",
    scope: { kind: "session", sessionId: "session-current-work-facts" },
    origin: { turnId: "turn-before", messageId: "message-before" },
    objective: "현재 작업 목표",
    status: "open",
    currentStage: "execution",
    allowedNextStages: ["review"],
    actionProgress: [],
    latestCheckpoint: staleCheckpoint,
    resultRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  expect(operationalWorkFacts(work, turnId)).toBeUndefined();
  const current = {
    ...work,
    latestCheckpoint: {
      ...staleCheckpoint,
      checkpointRevisionId: "checkpoint-current",
      revision: 2,
      publicSummary: "현재 Turn에서 저장한 진행 내용",
      nextStep: "현재 Turn의 다음 단계",
      originTurnId: turnId,
    },
  };
  expect(operationalWorkFacts(current, turnId)).toMatchObject({
    checkpointSummary: "현재 Turn에서 저장한 진행 내용",
    checkpointNextStep: "현재 Turn의 다음 단계",
  });

  const fallback = guidedOperationalFallback({
    originalRequest: "작업을 이어서 진행해 주세요.",
    work: current,
    workFacts: operationalWorkFacts(current, turnId),
    toolCalls: [],
    effects: [],
  });
  expect(fallback).toContain("현재 Turn에서 저장한 진행 내용");
  expect(fallback).toContain("현재 Turn의 다음 단계");
  expect(guidedOperationalFallback({
    originalRequest: "작업을 이어서 진행해 주세요.",
    work,
    toolCalls: [],
    effects: [],
  })).not.toContain("저장된 이전 진행 내용");
});

test("fallback keeps Work fields isolated by their own current-Turn provenance", () => {
  const turnId = "turn-field-provenance";
  const work: DurableWorkView = {
    workId: "guided-work-field-provenance",
    sessionId: "session-field-provenance",
    scope: { kind: "session", sessionId: "session-field-provenance" },
    origin: { turnId: "turn-old", messageId: "message-old" },
    objective: "오래된 목표",
    status: "completed",
    currentStage: "reporting",
    allowedNextStages: ["review"],
    actionProgress: [],
    latestCheckpoint: {
      checkpointRevisionId: "checkpoint-old",
      revision: 1,
      planRevisionId: "plan-old",
      stage: "execution",
      actionProgress: [],
      publicSummary: "오래된 체크포인트 요약",
      nextStep: "오래된 체크포인트 다음 단계",
      referencedResultRefs: [],
      originTurnId: "turn-old",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    latestResultReview: {
      reviewRevisionId: "review-current",
      revision: 2,
      subject: "result",
      verdict: "partial",
      summary: "현재 결과 검토를 확인했습니다.",
      corrections: [],
      boundResultRefs: [],
      originTurnId: turnId,
      createdAt: "2026-08-01T00:01:00.000Z",
    },
    latestDisposition: {
      dispositionRevisionId: "disposition-current",
      revision: 3,
      resultSequence: 1,
      materialFingerprint: "fingerprint-current",
      runtimeOwnedOpen: false,
      disposition: "completed",
      summary: "현재 처리 결과를 확인했습니다.",
      actionUpdates: [],
      remainingActions: [],
      evidenceRefs: [],
      evidenceSnapshot: [],
      followups: [],
      originTurnId: turnId,
      createdAt: "2026-08-01T00:02:00.000Z",
    },
    effectBlockers: [{
      blockerId: "blocker-current",
      sourceTurnId: turnId,
      capability: "workspace.file",
      target: "workspace:current.txt",
      detail: "현재 Turn에서 확인이 필요한 제한입니다.",
      createdAt: "2026-08-01T00:02:00.000Z",
    }],
    resultRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:02:00.000Z",
  };
  const facts = operationalWorkFacts(work, turnId);
  expect(facts).toMatchObject({
    status: "completed",
    resultSummary: "현재 결과 검토를 확인했습니다.",
    dispositionSummary: "현재 처리 결과를 확인했습니다.",
    blockers: ["현재 Turn에서 확인이 필요한 제한입니다."],
  });
  expect(facts).not.toHaveProperty("checkpointSummary");
  expect(facts).not.toHaveProperty("checkpointNextStep");

  const fallback = guidedOperationalFallback({
    originalRequest: "현재 결과를 알려 주세요.",
    responseLanguage: "ko",
    work,
    workFacts: facts,
    toolCalls: [],
    effects: [],
  });
  expect(fallback).toContain("요청한 작업은 완료됐습니다");
  expect(fallback).toContain("현재 결과 검토: 현재 결과 검토를 확인했습니다.");
  expect(fallback).toContain("현재 처리 결과: 현재 처리 결과를 확인했습니다.");
  expect(fallback).toContain("현재 제한: 현재 Turn에서 확인이 필요한 제한입니다.");
  expect(fallback).not.toContain("오래된 체크포인트");
  expect(fallback).not.toContain("오래된 체크포인트 다음 단계");
});

test("Work-derived fallback facts fail closed for internal names and paths", () => {
  const turnId = "turn-work-fact-safety";
  const work: DurableWorkView = {
    workId: "guided-work-safety-id",
    sessionId: "session-work-fact-safety",
    scope: { kind: "session", sessionId: "session-work-fact-safety" },
    origin: { turnId, messageId: "message-work-fact-safety" },
    objective: "현재 안전한 목표",
    status: "open",
    allowedNextStages: ["review"],
    actionProgress: [],
    latestCheckpoint: {
      checkpointRevisionId: "checkpoint-safety",
      revision: 1,
      planRevisionId: "plan-safety",
      stage: "execution",
      actionProgress: [],
      publicSummary: "Worker가 guided-work-safety-id를 /Users/test-user/Project Files에서 확인했습니다.",
      nextStep: "C:\\Users\\test-user\\Project Files\\next.md를 확인합니다.",
      referencedResultRefs: [],
      originTurnId: turnId,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    latestResultReview: {
      reviewRevisionId: "review-safety",
      revision: 2,
      subject: "result",
      verdict: "partial",
      summary: "docs/read me.md에서 결과를 확인했습니다.",
      corrections: [],
      boundResultRefs: [],
      originTurnId: turnId,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    resultRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const facts = operationalWorkFacts(work, turnId);
  expect(facts).toMatchObject({ objective: "현재 안전한 목표" });
  expect(facts).not.toHaveProperty("checkpointSummary");
  expect(facts).not.toHaveProperty("checkpointNextStep");
  expect(facts).not.toHaveProperty("resultSummary");
  const fallback = guidedOperationalFallback({
    originalRequest: "안전하게 결과를 알려 주세요.",
    responseLanguage: "ko",
    work,
    workFacts: facts,
    toolCalls: [],
    effects: [],
  });
  expect(fallback).not.toContain("Worker");
  expect(fallback).not.toContain("guided-work-safety-id");
  expect(fallback).not.toContain("/Users/test-user");
  expect(fallback).not.toContain("Project Files");
  expect(fallback).not.toContain("docs/read me.md");
});

test("Guided operational fallback does not count returned tool failures as success", () => {
  const fallback = guidedOperationalFallback({
    originalRequest: "실패한 도구 결과를 사실대로 알려 주세요.",
    work: null,
    toolCalls: Array.from({ length: 5 }, (_, index) => ({
      callId: `failed-call-${index}`,
      toolName: "run_command",
      rawArguments: "{}",
      arguments: {},
      status: "completed" as const,
      result: {
        ok: false,
        error: { code: "effect_plan_review_required" },
      },
    })),
    effects: [],
  });

  expect(fallback).toContain("답변 생성을 마치지 못했습니다");
  expect(fallback).not.toContain("journal");
  expect(fallback).not.toContain("Tool run_command");
  expect(fallback).not.toContain("rejected_or_failed");
});

test("Guided operational fallback follows configured response language", () => {
  const fallback = guidedOperationalFallback({
    originalRequest: "이 요청은 한국어로 작성되었습니다.",
    responseLanguage: "English",
    work: null,
    toolCalls: [],
    effects: [],
  });

  expect(fallback).toContain("could not finish generating the answer");
  expect(fallback).not.toContain("답변 생성을");
});

test("Guided operational fallback is captured without a second report model call", async () => {
  const toolCall = {
    callId: "guided-fallback-precomputed-call",
    toolName: "read_file",
    rawArguments: "{}",
    arguments: {},
    status: "started" as "started" | "completed",
    result: { marker: "captured-before-report-model" },
  };
  let calls = 0;

  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw knownProviderFailure("main provider failure");
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "현재까지 확인한 내용을 알려 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "현재까지 확인한 내용을 알려 주세요.",
    loadFacts: async () => ({
      work: null,
      toolCalls: [toolCall],
      effects: [],
    }),
  });

  expect(calls).toBe(1);
  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toContain("Tool read_file");
  expect(answer).not.toContain("captured-before-report-model");
});

test("Guided operational fallback never exposes a model budget or retry request", async () => {
  let calls = 0;
  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw knownProviderFailure("main provider failure");
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "결과를 알려 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "결과를 알려 주세요.",
    loadFacts: async () => ({
      work: null,
      toolCalls: [],
      effects: [],
    }),
  });

  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toContain("available tool budget");
  expect(answer).not.toContain("another turn");
  expect(answer).not.toMatch(/retry|다시 요청/iu);
  expect(calls).toBe(1);
});

test("Guided operational fallback is deterministic instead of a persona model call", async () => {
  let calls = 0;
  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw knownProviderFailure("main provider failure");
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "작업을 완료해 줘.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "작업을 완료해 줘.",
    loadFacts: async () => ({ work: null, toolCalls: [], effects: [] }),
  });

  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(calls).toBe(1);
});

test("Guided empty main response returns a deterministic fact-based fallback", async () => {
  let calls = 0;
  let factLoads = 0;

  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      return { text: "   ", toolCalls: [] };
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "빈 응답을 보고 가능한 실패로 처리해 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "빈 응답을 보고 가능한 실패로 처리해 주세요.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  });

  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toMatch(/다시 요청|retry|continue/iu);
  expect(calls).toBe(1);
  expect(factLoads).toBe(1);
});

test("Guided model exhaustion uses the deterministic fallback without another model round", async () => {
  let calls = 0;
  let factLoads = 0;
  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "도구 실행이 끝나지 않은 요청입니다.",
      tools: [{
        name: "echo",
        description: "Echo a safe message.",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      }],
      modelRound: scriptedModelRound([
        () => {
          calls += 1;
          return toolResponse([toolCall("exhaustion-call", "echo", {
            message: "still working",
          })]);
        },
      ]),
      maxIterations: 1,
      executeTool: async () => ({ ok: true }),
    },
    parentSignal: new AbortController().signal,
    originalRequest: "도구 실행이 끝나지 않은 요청입니다.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  });

  expect(calls).toBe(1);
  expect(factLoads).toBe(1);
  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toContain("available tool budget");
  expect(answer).not.toContain("echo: ok");
});

test("Guided unexpected local failure does not start an operational report request", async () => {
  let calls = 0;
  let factLoads = 0;

  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw new Error("local prompt assembly invariant failed");
    },
  ]);

  await expect(runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "로컬 오류는 위로 전달해 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "로컬 오류는 위로 전달해 주세요.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  })).rejects.toThrow("local prompt assembly invariant failed");

  expect(calls).toBe(1);
  expect(factLoads).toBe(0);
});

test("Guided permanent provider failure does not start an operational report request", async () => {
  let calls = 0;
  let factLoads = 0;
  const permanent = new ModelProviderRequestError({
    code: "provider_auth_error",
    message: "provider credentials rejected",
    provider: "test-provider",
    retryable: false,
  });

  await expect(runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "영구적인 제공자 오류를 전달해 주세요.",
      tools: [],
      modelRound: scriptedModelRound([
        () => {
          calls += 1;
          throw permanent;
        },
      ]),
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "영구적인 제공자 오류를 전달해 주세요.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  })).rejects.toBe(permanent);

  expect(calls).toBe(1);
  expect(factLoads).toBe(0);
});

test("Guided parent cancellation does not deliver an operational fallback", async () => {
  const controller = new AbortController();
  const stopped = new Error("user stopped the Turn");
  let factLoads = 0;
  const modelRound = scriptedModelRound([
    (request) => new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = () => reject(request.signal?.reason);
      if (request.signal?.aborted) rejectOnAbort();
      else request.signal?.addEventListener("abort", rejectOnAbort, { once: true });
    }),
  ]);
  const running = runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "중지할 작업",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: controller.signal,
    originalRequest: "중지할 작업",
    loadFacts: async () => {
      factLoads += 1;
      return {
        work: null,
        toolCalls: [],
        effects: [],
      };
    },
  });

  controller.abort(stopped);

  await expect(running).rejects.toThrow("user stopped the Turn");
  expect(factLoads).toBe(0);
});

test("process replacement interruption rejects identically without finalizing the tool call", async () => {
  const fixture = createFixture("guided-process-replacement-interruption");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "turn-process-replacement-interruption",
    });
    const interruption = new GuidedEffectProcessReplacementError();
    const args = { query: "fact", path: "." };
    const callId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "0",
      "grep_files",
      stableJson(args),
    ].join("\0"));
    const operations: string[] = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["grep_files"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      workspacePath: () => fixture.root,
      butlerData: fixture.root,
      executeButlerTool: async () => {
        throw interruption;
      },
    });

    let caught: unknown;
    try {
      await executor.executeTool({
        name: "grep_files",
        args,
        rawArguments: JSON.stringify(args),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(interruption);
    expect(caught).toBeInstanceOf(GuidedEffectProcessReplacementError);
    expect(operations).toEqual(["started"]);
    expect(fixture.stores.guidedToolJournal.find(callId)?.status).toBe(
      "started",
    );
  } finally {
    fixture.close();
  }
});

async function addAttachedFileResult(
  fixture: ReturnType<typeof createFixture>,
  input: {
    turnId: string;
    callId: string;
    toolName: "write_file" | "edit_file";
    attach?: boolean;
  },
): Promise<void> {
  const args = { path: "index.html" };
  fixture.stores.guidedToolJournal.start({
    turnId: input.turnId,
    callId: input.callId,
    toolName: input.toolName,
    rawArguments: JSON.stringify(args),
    arguments: args,
  });
  fixture.stores.guidedToolJournal.finish({
    callId: input.callId,
    status: "completed",
    result: {
      ok: true,
      path: "index.html",
      ...(input.toolName === "write_file" ? { created: true } : { edited: true }),
    },
  });
  if (input.attach !== false) {
    await fixture.stores.durableWork.attachToolResult({
      turnId: input.turnId,
      sessionId: "guided-local-session",
      mutationCallId: `attach-${input.callId}`,
      toolCallId: input.callId,
    });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function closeoutRowCounts(
  dbPath: string,
  turnId: string,
): { diagnostics: number; dispositions: number } {
  const db = new Database(dbPath);
  try {
    return {
      diagnostics: db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_closeout_diagnostics
        WHERE turn_id = ?
      `).get(turnId)?.count ?? 0,
      dispositions: db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions
        WHERE origin_turn_id = ?
      `).get(turnId)?.count ?? 0,
    };
  } finally {
    db.close(false);
  }
}

function overrideTurnCommit(
  turns: TurnStateRepository,
  commitTransition: TurnStateRepository["commitTransition"],
): TurnStateRepository {
  return new Proxy(turns, {
    get(target, property) {
      if (property === "commitTransition") return commitTransition;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? value.bind(target)
        : value;
    },
  });
}

function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: label,
    storageProfile: "ephemeral",
  });
  return {
    root,
    dbPath,
    stores,
    agent(
      modelRound: ModelRoundPort,
      operational: {
        butlerHome?: string;
        durableWork?: DurableWorkService;
      } = {},
    ) {
      const { butlerHome = root } = operational;
      return createProductionGuidedTurnAgent({
        phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
        butlerHome,
        butlerData: root,
        contextDocuments: stores.contextDocuments,
        toolJournal: stores.guidedToolJournal,
        operationResultReader: stores.guidedOperationResultReader,
        effectJournal: stores.guidedEffectJournal,
        durableWork: operational.durableWork ?? stores.durableWork,
        modelRound,
      });
    },
    close() {
      stores.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runGit(args: string[], cwd: string, gitDir = false): string {
  const command = gitDir ? ["git", `--git-dir=${cwd}`, ...args] : ["git", ...args];
  const result = Bun.spawnSync({
    cmd: command,
    ...(gitDir ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function prepareAppProjectsTable(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      workspace_path TEXT,
      workspace_label TEXT,
      safe_path_label TEXT,
      ledger_project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
  } finally {
    db.close(false);
  }
}

function bindAppProject(
  dbPath: string,
  input: {
    id: string;
    workspacePath: string;
    ledgerProjectId: string;
    archived?: boolean;
  },
): void {
  prepareAppProjectsTable(dbPath);
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO projects (
        id, display_name, workspace_path, workspace_label, safe_path_label,
        ledger_project_id, archived, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.id,
      input.workspacePath,
      input.id,
      input.ledgerProjectId,
      input.ledgerProjectId,
      input.archived ? 1 : 0,
      "2026-07-31T00:00:00.000Z",
    );
  } finally {
    db.close(false);
  }
}

function fixtureMcpServerEval(): string {
  return `
    import { appendFileSync } from "node:fs";
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";

    const server = new McpServer({ name: "guided-tool-fixture", version: "1.0.0" });
    server.tool("find_issue", "Find issue records", { query: z.string() }, async ({ query }) => {
      if (process.env.MCP_CALL_LOG) appendFileSync(process.env.MCP_CALL_LOG, "find_issue\\n");
      return { content: [{ type: "text", text: "issue:" + query }] };
    });
    server.resource("fixture", "butler://fixture", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture" }],
    }));
    await server.connect(new StdioServerTransport());
  `;
}

function turnRecord(
  workspacePath: string,
  options: {
    turnId?: string;
    accessMode?: "full_access" | "ask_first" | "read_only";
    trackingMode?: "ledger" | "local" | "none";
    projectId?: string;
    attachments?: NonNullable<TurnRecord["context"]["attachments"]>;
  } = {},
): TurnRecord {
  const turnId = options.turnId ?? "guided-agent-turn";
  return {
    turnId,
    sessionId: "guided-agent-session",
    inboxId: `inbox:${turnId}`,
    triggerKey: `trigger:${turnId}`,
    originalMessageId: `message:${turnId}`,
    originalMessage: "요청을 처리해 주세요",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: options.accessMode ?? "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(options.projectId ? { projectRef: options.projectId } : {}),
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: options.accessMode ?? "full_access",
        trackingMode: options.trackingMode ?? "none",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
      ...(options.attachments ? { attachments: options.attachments } : {}),
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: `checkpoint:${turnId}`,
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}

function knownProviderFailure(message: string): ModelProviderRequestError {
  return new ModelProviderRequestError({
    code: "provider_api_error",
    message,
    provider: "test-provider",
    api: "test-api",
    retryable: true,
  });
}

function localRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-local-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "기존 파일을 작게 수정해 주세요",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: ["workspace"],
        requiredNativeTools: [],
        workspacePath,
      },
    },
  };
}

function projectRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-project-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "프로젝트 작업을 만들고 기록해 주세요",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      projectRef: "guided-project-session",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "ledger",
        requiredNativeToolProfiles: ["workspace", "project", "project-lifecycle"],
        requiredNativeTools: [],
        workspacePath,
        projectId: "guided-project-session",
      },
    },
  };
}

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BtccRunCommand,
  BtccTurnProgressObserver,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type {
  ModelRoundMessage,
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { createTurnRuntime as createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { seedLegacySessionWork } from
  "./support/btcc-r3-legacy-session-work-fixture.ts";

test("R3 managed Work survives a store restart and continues in a fresh Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-integration-"));
  const dbPath = join(root, "butler.sqlite");
  const firstTurnId = "work-turn-1";
  const stages: string[] = [];
  const firstStores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-integration-first",
    storageProfile: "ephemeral",
  });
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      progress: checkpointProgress(stages),
      modelRound: scriptedModelRound([
        (request) => {
          expect(request.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
            "replace_work_plan",
            "record_work_checkpoint",
            "record_work_review",
            "write_file",
          ]));
          return toolResponse([toolCall("work-plan-1", "replace_work_plan", {
            objective: "Create and verify report.md",
            actions: [{
              action_key: "write_report",
              description: "Write the requested report",
              dependency_keys: [],
              effect: { capability: "write_file", target: "workspace:report.md" },
            }],
            checks: ["report.md contains the requested result"],
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "replace_work_plan")).toMatchObject({
            ok: true,
            work: { status: "open" },
          });
          return toolResponse([toolCall("work-plan-review-1", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The plan directly produces and checks the requested artifact.",
            corrections: [],
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_review")).toMatchObject({ ok: true });
          return toolResponse([toolCall("write-report-1", "write_file", {
            path: "report.md",
            content: "# Verified report\n\nThe durable artifact is ready.\n",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "write_file")).toMatchObject({
            ok: true,
            effect: "workspace_file_write",
            effect_receipt: {
              capability: "write_file",
              target: "workspace:report.md",
            },
          });
          return toolResponse([toolCall("work-checkpoint-1", "record_work_checkpoint", {
            next_stage: "review",
            action_updates: [{
              action_key: "write_report",
              status: "done",
              note: "The requested report was written and verified.",
            }],
            public_summary: "보고서를 작성하고 실제 파일을 확인했습니다.",
            next_step: "사용자 요청에 맞는지 최종 검토합니다.",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_checkpoint")).toMatchObject({ ok: true });
          return { text: "보고서를 작성하고 확인했습니다.", toolCalls: [] };
        },
      ]),
    });

    expect(await runtime.runTurn(command(root, firstTurnId,
      "조사 결과를 report.md로 만들고 확인해 주세요."))).toMatchObject({
      kind: "delivered",
      content: "보고서를 작성하고 확인했습니다.",
    });
    expect((await firstStores.turns.findTurn(firstTurnId))?.route).toBe("managed");
    expect(readFileSync(join(root, "report.md"), "utf8")).toContain("Verified report");
    expect(stages).toEqual(["보고서를 작성하고 실제 파일을 확인했습니다."]);

    const firstWork = await firstStores.durableWork.boundWorkForTurn(firstTurnId);
    expect(firstWork).toMatchObject({
      status: "open",
      currentPlan: { revision: 1 },
      latestPlanReview: { subject: "plan", verdict: "accept" },
      latestCheckpoint: { stage: "review" },
    });
    expect(firstWork?.resultRefs.map((result) => result.toolName)).toEqual(["write_file"]);
  } finally {
    firstStores.close();
  }

  const secondTurnId = "work-turn-2";
  const secondStores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-integration-second",
    storageProfile: "ephemeral",
  });
  try {
    let continuationPrompt = "";
    const runtime = createRuntime({
      root,
      dbPath,
      stores: secondStores,
      modelRound: scriptedModelRound([
        (request) => {
          continuationPrompt = request.messages[0]?.content ?? "";
          return toolResponse([toolCall("read-report-1", "read_file", {
            path: "report.md",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "read_file")).toMatchObject({
            content: expect.stringContaining("Verified report"),
          });
          return toolResponse([toolCall("result-review-1", "record_work_review", {
            subject: "result",
            verdict: "accept",
            summary: "The requested file exists and contains the verified report.",
            corrections: [],
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_review")).toMatchObject({
            ok: true,
            work: { status: "open", current_stage: "review" },
          });
          return toolResponse([toolCall("completion-review-1", "record_work_review", {
            subject: "completion",
            verdict: "accept",
            summary: "The whole Work satisfies the original request and current Plan.",
            corrections: [],
            next_stage: "reporting",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_review")).toMatchObject({
            ok: true,
            work: { status: "completed", current_stage: "reporting" },
          });
          return {
            text: "이전 작업을 이어 최종 검토까지 마쳤습니다.",
            toolCalls: [],
          };
        },
      ]),
    });

    expect(await runtime.runTurn(command(root, secondTurnId, "이어서 마무리해 주세요.")))
      .toMatchObject({
        kind: "delivered",
        content: "이전 작업을 이어 최종 검토까지 마쳤습니다.",
      });
    expect(continuationPrompt).toContain("## Current Work");
    expect(continuationPrompt).toContain(
      "Original request (highest priority): 조사 결과를 report.md로 만들고 확인해 주세요.",
    );
    expect(continuationPrompt).toContain("Result (write_file, completed)");
    expect(continuationPrompt).not.toContain("guided-work-");

    const completed = await secondStores.durableWork.boundWorkForTurn(secondTurnId);
    expect(completed).toMatchObject({
      status: "completed",
      currentStage: "reporting",
      currentPlan: { revision: 1 },
      latestPlanReview: { subject: "plan", verdict: "accept" },
      latestResultReview: { subject: "result", verdict: "accept" },
      latestCompletionValidation: {
        subject: "completion",
        verdict: "accept",
      },
    });
    expect(completed?.resultRefs.map((result) => result.toolName))
      .toEqual(["write_file", "read_file"]);
    expect(completed?.latestResultReview?.boundResultRefs)
      .toEqual(completed?.resultRefs.map((result) => result.resultRef));
    expect(completed?.origin.turnId).toBe(firstTurnId);
    expect((await secondStores.turns.findTurn(secondTurnId))?.route).toBe("managed");
  } finally {
    secondStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3 Stop cancels only the Turn and leaves Work resumable after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-stop-"));
  const dbPath = join(root, "butler.sqlite");
  const stoppedTurnId = "stopped-work-turn";
  let releaseStarted!: () => void;
  const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const firstStores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-stop-first",
    storageProfile: "ephemeral",
  });
  let originalWorkId = "";
  let postStopReview = "not-attempted";
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      modelRound: scriptedModelRound([
        (request) => toolResponse([toolCall("stop-plan-1", "replace_work_plan", {
          objective: "Prepare a resumable report",
          actions: [{
            action_key: "prepare",
            description: "Prepare and verify the report",
            dependency_keys: [],
          }],
          checks: ["The report is verified"],
        })]),
        (request) => {
          const plan = lastToolOutput(request, "replace_work_plan") as {
            work?: { work_id?: string };
          };
          originalWorkId = plan.work?.work_id ?? "";
          return toolResponse([toolCall("stop-review-checkpoint-1", "record_work_checkpoint", {
            next_stage: "review",
            public_summary: "계획을 실행할 준비가 됐습니다.",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_checkpoint")).toMatchObject({ ok: true });
          return toolResponse([toolCall("stop-execution-checkpoint-1", "record_work_checkpoint", {
            next_stage: "execution",
            action_updates: [{ action_key: "prepare", status: "active" }],
            public_summary: "보고서를 준비하고 있습니다.",
            next_step: "남은 내용을 작성하고 검증합니다.",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_checkpoint")).toMatchObject({ ok: true });
          releaseStarted();
          return new Promise<never>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              postStopReview = "fenced";
              reject(new Error("aborted"));
            }, {
              once: true,
            });
          });
        },
      ]),
    });
    const running = runtime.runTurn(command(
      root,
      stoppedTurnId,
      "긴 보고서를 작성해 주세요.",
    ));
    await started;
    expect(await runtime.stopTurn({ kind: "stop", turnId: stoppedTurnId }))
      .toEqual({ kind: "cancelled", turnId: stoppedTurnId });
    expect(await running).toEqual({ kind: "cancelled", turnId: stoppedTurnId });
    expect(postStopReview).toBe("fenced");
    expect(await firstStores.durableWork.boundWorkForTurn(stoppedTurnId)).toMatchObject({
      workId: originalWorkId,
      status: "open",
      latestCheckpoint: { stage: "execution" },
    });
    expect((await firstStores.durableWork.boundWorkForTurn(stoppedTurnId))
      ?.latestResultReview).toBeUndefined();
  } finally {
    firstStores.close();
  }

  const resumedStores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-stop-second",
    storageProfile: "ephemeral",
  });
  try {
    const resumedTurnId = "resumed-work-turn";
    let prompt = "";
    const runtime = createRuntime({
      root,
      dbPath,
      stores: resumedStores,
      modelRound: scriptedModelRound([
        (request) => {
          prompt = request.messages[0]?.content ?? "";
          return toolResponse([toolCall("resume-checkpoint-1", "record_work_checkpoint", {
            action_updates: [{ action_key: "prepare", status: "active" }],
            public_summary: "중지된 실행 상태와 남은 작업을 복구했습니다.",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_checkpoint")).toMatchObject({ ok: true });
          return {
            text: "중지된 작업 기록을 확인했고 이어서 진행할 수 있습니다.",
            toolCalls: [],
          };
        },
      ]),
    });

    expect(await runtime.runTurn(command(
      root,
      resumedTurnId,
      "아까 중지한 작업을 이어가 주세요.",
    ))).toMatchObject({ kind: "delivered" });
    expect(prompt).toContain(
      "Original request (highest priority): 긴 보고서를 작성해 주세요.",
    );
    expect(prompt).toContain("Latest progress (execution)");
    expect(await resumedStores.durableWork.boundWorkForTurn(resumedTurnId))
      .toMatchObject({ workId: originalWorkId, status: "open" });
  } finally {
    resumedStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a presented open Work binds only at the first real tool and exposes its result to the next Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-late-bind-"));
  const dbPath = join(root, "butler.sqlite");
  const sourcePath = join(root, "source.txt");
  writeFileSync(sourcePath, "durable observed fact\n");
  const originTurnId = "late-bind-origin";
  const directTurnId = "late-bind-direct";
  const toolTurnId = "late-bind-tool";
  const firstStores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-late-bind-first",
    storageProfile: "ephemeral",
  });
  let workId = "";
  try {
    const originRuntime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      modelRound: scriptedModelRound([
        () => toolResponse([toolCall("late-bind-plan-1", "replace_work_plan", {
          objective: "Read source.txt and report the observed fact",
          actions: [{
            action_key: "read_source",
            description: "Read the source file",
            dependency_keys: [],
          }],
          checks: ["The reported fact matches source.txt"],
        })]),
        (request) => {
          const opened = lastToolOutput(request, "replace_work_plan") as {
            work?: { work_id?: string };
          };
          workId = opened.work?.work_id ?? "";
          return { text: "작업 기록을 준비했습니다.", toolCalls: [] };
        },
      ]),
    });
    await originRuntime.runTurn(command(
      root,
      originTurnId,
      "source.txt를 확인하고 결과를 알려 주세요.",
    ));

    let directPrompt = "";
    const directActivities: Array<{ displayStage?: string }> = [];
    const directRuntime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          directActivities.push(update);
        },
      },
      modelRound: scriptedModelRound([
        (request) => {
          directPrompt = request.messages[0]?.content ?? "";
          return { text: "별개의 간단한 질문에는 바로 답합니다.", toolCalls: [] };
        },
      ]),
    });
    expect(await directRuntime.runTurn(command(
      root,
      directTurnId,
      "별개의 간단한 질문입니다.",
    ))).toMatchObject({ kind: "delivered" });
    expect(directPrompt).toContain("## Current Work");
    expect(await firstStores.durableWork.boundWorkForTurn(directTurnId)).toBeNull();
    expect(directActivities).toEqual([]);

    const toolActivities: Array<{ displayStage?: string }> = [];
    const interruptedRuntime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          toolActivities.push(update);
        },
      },
      modelRound: scriptedModelRound([
        () => toolResponse([toolCall("late-bind-read-1", "read_file", {
          path: "source.txt",
        })]),
        (request) => {
          expect(lastToolOutput(request, "read_file")).toMatchObject({
            content: "durable observed fact\n",
          });
          throw new Error("provider disconnected after the committed tool result");
        },
      ]),
    });
    await interruptedRuntime.runTurn(command(
      root,
      toolTurnId,
      "열린 작업을 이어서 파일부터 확인해 주세요.",
    ));
    expect(await firstStores.durableWork.boundWorkForTurn(toolTurnId)).toMatchObject({
      workId,
      resultRefs: [{
        toolName: "read_file",
        status: "completed",
        originTurnId: toolTurnId,
      }],
    });
    expect(toolActivities.map(({ displayStage }) => displayStage))
      .toEqual(["execution"]);
  } finally {
    firstStores.close();
  }

  const resumedStores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-late-bind-second",
    storageProfile: "ephemeral",
  });
  try {
    const nextTurnId = "late-bind-next";
    let nextPrompt = "";
    const nextActivities: Array<{ displayStage?: string }> = [];
    const resumedRuntime = createRuntime({
      root,
      dbPath,
      stores: resumedStores,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          nextActivities.push(update);
        },
      },
      modelRound: scriptedModelRound([
        (request) => {
          nextPrompt = request.messages[0]?.content ?? "";
          return { text: "이전 도구 결과를 확인했습니다.", toolCalls: [] };
        },
      ]),
    });
    await resumedRuntime.runTurn(command(
      root,
      nextTurnId,
      "방금 확인한 결과를 이어서 알려 주세요.",
    ));
    expect(nextPrompt).toContain("Result (read_file, completed)");
    expect(nextPrompt).toContain("durable observed fact");
    expect(await resumedStores.durableWork.boundWorkForTurn(nextTurnId)).toBeNull();
    expect(nextActivities).toEqual([]);
    expect((await resumedStores.durableWork.loadContext({
      turnId: nextTurnId,
      sessionId: "durable-work-session",
    }))?.work.resultRefs).toHaveLength(1);
  } finally {
    resumedStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action-key summary without optional description cannot trap the model loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-work-nonblocking-"));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-nonblocking",
    storageProfile: "ephemeral",
  });
  const turnId = "work-nonblocking-turn";
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores,
      modelRound: scriptedModelRound([
        () => toolResponse([toolCall("nonblocking-plan-summary", "replace_work_plan", {
          objective: "Create answer.txt",
          actions: [{
            action_key: "요청한 답변 파일 작성",
            dependency_keys: [],
          }],
          checks: ["answer.txt contains the requested result"],
        })]),
        (request) => {
          expect(lastToolOutput(request, "replace_work_plan")).toMatchObject({
            ok: true,
            work: {
              actions: [{
                action_key: "요청한 답변 파일 작성",
                status: "pending",
              }],
            },
          });
          return { text: "행동 요약이 유지된 계획으로 계속 진행할 수 있습니다.", toolCalls: [] };
        },
      ]),
    });

    expect(await runtime.runTurn(command(root, turnId, "answer.txt를 만들어 주세요.")))
      .toMatchObject({
        kind: "delivered",
        content: "행동 요약이 유지된 계획으로 계속 진행할 수 있습니다.",
      });
    expect(await stores.durableWork.boundWorkForTurn(turnId)).toMatchObject({
      status: "open",
      currentPlan: {
        actions: [{
          actionKey: "요청한 답변 파일 작성",
          description: "요청한 답변 파일 작성",
        }],
      },
    });
    expect((await stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected stage transition is not projected as accepted progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-rejected-stage-projection-"));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "rejected-stage-projection",
    storageProfile: "ephemeral",
  });
  const activities: Array<{
    displayStage?: string;
    title: string;
    summary: string;
  }> = [];
  const checklists: string[][] = [];
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          activities.push(update);
        },
        workProgressChanged(update) {
          checklists.push(update.tasks.map((task) => task.taskState));
        },
      },
      modelRound: scriptedModelRound([
        () => {
          const planArgs = {
            objective: "Prepare the requested answer",
            actions: [{
              action_key: "prepare-answer",
              description: "Prepare the answer",
              dependency_keys: [],
            }],
            checks: ["The answer addresses the request"],
          };
          return toolResponse([
            toolCall("rejected-plan-1", "replace_work_plan", planArgs),
          ], "요청에 맞는 계획을 세웁니다.");
        },
        (request) => {
          expect(lastToolOutput(request, "replace_work_plan"))
            .toMatchObject({ ok: true });
          const invalidArgs = {
            next_stage: "execution",
            public_summary: "REJECTED STAGE MUST NOT APPEAR",
          };
          return toolResponse([
            toolCall("rejected-checkpoint-1", "record_work_checkpoint", invalidArgs),
          ], "잘못된 전이를 시도합니다.");
        },
        (request) => {
          expect(lastToolOutput(request, "record_work_checkpoint"))
            .toMatchObject({
              ok: false,
              error: {
                code: "invalid_work_stage_transition",
                current_stage: "planning",
                attempted_stage: "execution",
                allowed_next_stages: ["review"],
              },
            });
          return {
            text: "전이 오류와 무관하게 확인 가능한 답변을 전달합니다.",
            toolCalls: [],
          };
        },
      ]),
    });

    expect(await runtime.runTurn(command(
      root,
      "rejected-stage-projection-turn",
      "확인 가능한 답변을 주세요.",
      "rejected-stage-projection-session",
    ))).toMatchObject({
      kind: "delivered",
      content: "전이 오류와 무관하게 확인 가능한 답변을 전달합니다.",
    });
    expect(activities.map((activity) => activity.displayStage)).toEqual([
      "conception",
      "planning",
      "planning",
    ]);
    expect(activities.at(-1)).toMatchObject({
      title: "부분 결과 안내",
      summary: "전이 오류와 무관하게 확인 가능한 답변을 전달합니다.",
    });
    expect(activities.some((activity) =>
      activity.summary.includes("REJECTED STAGE"))).toBe(false);
    expect(checklists).toEqual([["planned"]]);
    expect(await stores.durableWork.boundWorkForTurn(
      "rejected-stage-projection-turn",
    )).toMatchObject({
      currentStage: "planning",
      actionProgress: [{ actionKey: "prepare-answer", status: "pending" }],
    });
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production R3 agent imports and continues open R2 Session Work", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-product-legacy-work-"));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "work-product-legacy-import",
    storageProfile: "ephemeral",
  });
  const legacyDb = new Database(dbPath);
  seedLegacySessionWork(legacyDb);
  legacyDb.close();
  writeFileSync(join(root, "legacy-source.txt"), "fact carried from the R2 task\n");
  const turnId = "r3-product-legacy-import-turn";
  try {
    let prompt = "";
    const runtime = createRuntime({
      root,
      dbPath,
      stores,
      modelRound: scriptedModelRound([
        (request) => {
          prompt = request.messages[0]?.content ?? "";
          return toolResponse([toolCall("legacy-read-1", "read_file", {
            path: "legacy-source.txt",
          })]);
        },
        (request) => {
          expect(lastToolOutput(request, "read_file")).toMatchObject({
            content: "fact carried from the R2 task\n",
          });
          return {
            text: "R2에서 열려 있던 작업과 현재 파일을 확인해 이어서 처리했습니다.",
            toolCalls: [],
          };
        },
      ]),
    });

    expect(await runtime.runTurn(command(
      root,
      turnId,
      "이전 작업을 이어서 처리해 주세요.",
      "session-fixture",
    ))).toMatchObject({ kind: "delivered" });
    expect(prompt).toContain("## Current Work");
    expect(prompt).toContain(
      "Original request (highest priority): Start the four-task Program",
    );
    expect(prompt).toContain("Imported prior progress: 2 of 4 planned actions");
    expect(await stores.durableWork.boundWorkForTurn(turnId)).toMatchObject({
      status: "open",
      resultRefs: [{ toolName: "read_file", originTurnId: turnId }],
    });
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3 projects the existing Plan, tool, Review, and final events without another model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-activity-projection-"));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "activity-projection",
    storageProfile: "ephemeral",
  });
  const activities: Array<{
    activityId: string;
    displayStage?: string;
    title: string;
    summary: string;
  }> = [];
  const operations: Array<{ activityId: string; status: string }> = [];
  let modelCalls = 0;
  writeFileSync(join(root, "source.txt"), "observed result\n");
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          activities.push(update);
        },
        operationChanged(update) {
          operations.push(update);
        },
      },
      modelRound: scriptedModelRound([
        () => {
          modelCalls += 1;
          const planArgs = {
            objective: "Read and report the requested source",
            actions: [{
              action_key: "read_source",
              description: "Read source.txt",
              dependency_keys: [],
            }],
            checks: ["The final answer uses the observed file content"],
          };
          return toolResponse([
            toolCall("activity-plan-1", "replace_work_plan", planArgs),
          ], "먼저 요청에 맞는 작업 계획을 세웁니다.");
        },
        (request) => {
          modelCalls += 1;
          expect(lastToolOutput(request, "replace_work_plan")).toMatchObject({
            ok: true,
          });
          const planReviewArgs = {
            subject: "plan",
            verdict: "accept",
            summary: "The plan directly reads the requested source before reporting.",
            corrections: [],
          };
          return toolResponse([
            toolCall("activity-plan-review-1", "record_work_review", planReviewArgs),
          ], "계획이 요청을 직접 충족하는지 확인합니다.");
        },
        (request) => {
          modelCalls += 1;
          expect(lastToolOutput(request, "record_work_review")).toMatchObject({
            ok: true,
          });
          return toolResponse([
            toolCall("activity-read-1", "read_file", { path: "source.txt" }),
          ], "계획에 따라 실제 파일 내용을 확인합니다.");
        },
        (request) => {
          modelCalls += 1;
          expect(lastToolOutput(request, "read_file"))
            .toMatchObject({ content: "observed result\n" });
          const reviewArgs = {
            subject: "result",
            verdict: "accept",
            summary: "The requested source was read and is ready to report.",
            corrections: [],
          };
          return toolResponse([
            toolCall("activity-result-review-1", "record_work_review", reviewArgs),
          ], "실제 결과를 원래 요청과 대조해 검토합니다.");
        },
        (request) => {
          modelCalls += 1;
          expect(lastToolOutput(request, "record_work_review")).toMatchObject({
            ok: true,
          });
          return { text: "source.txt의 실제 내용은 observed result입니다.", toolCalls: [] };
        },
      ]),
    });

    expect(await runtime.runTurn(command(
      root,
      "activity-projection-turn",
      "source.txt를 읽고 결과를 알려 주세요.",
    ))).toMatchObject({
      kind: "delivered",
      content: "source.txt의 실제 내용은 observed result입니다.",
    });
    expect(modelCalls).toBe(5);
    expect(activities.map(({ displayStage }) => displayStage)).toEqual([
      "conception",
      "planning",
      "review",
      "execution",
      "review",
      "review",
    ]);
    expect(activities.at(-1)).toMatchObject({
      title: "부분 결과 안내",
      summary: "source.txt의 실제 내용은 observed result입니다.",
    });
    const operationActivityIds = new Set(operations.map(({ activityId }) => activityId));
    expect([...operationActivityIds]).toEqual(
      activities.slice(1, 5).map(({ activityId }) => activityId),
    );
    expect(operations.map(({ status }) => status)).toEqual([
      "started", "completed",
      "started", "completed",
      "started", "completed",
      "started", "completed",
    ]);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3 activity projection failure cannot veto its tool result or final delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-activity-nonauthority-"));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "activity-nonauthority",
    storageProfile: "ephemeral",
  });
  let modelCalls = 0;
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores,
      progress: {
        stateChanged() {},
        phaseActivityChanged() {
          throw new Error("simulated activity projection failure");
        },
      },
      modelRound: scriptedModelRound([
        () => {
          modelCalls += 1;
          const planArgs = {
            objective: "Preserve the requested result despite a UI projection failure",
            actions: [{
              action_key: "report_result",
              description: "Return the requested result",
              dependency_keys: [],
            }],
            checks: ["The final answer is delivered unchanged"],
          };
          return toolResponse([
            toolCall("nonauthority-plan-1", "replace_work_plan", planArgs),
          ], "요청을 처리할 계획을 세웁니다.");
        },
        (request) => {
          modelCalls += 1;
          expect(lastToolOutput(request, "replace_work_plan")).toMatchObject({
            ok: true,
            work: { status: "open" },
          });
          return {
            text: "활동 표시 실패와 무관하게 최종 답변을 전달합니다.",
            toolCalls: [],
          };
        },
      ]),
    });

    expect(await runtime.runTurn(command(
      root,
      "activity-nonauthority-turn",
      "작업 계획을 세우고 결과를 알려 주세요.",
      "activity-nonauthority-session",
    ))).toMatchObject({
      kind: "delivered",
      content: "활동 표시 실패와 무관하게 최종 답변을 전달합니다.",
    });
    expect(modelCalls).toBe(2);
    expect(await stores.durableWork.boundWorkForTurn("activity-nonauthority-turn"))
      .toMatchObject({ status: "open" });
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3 keeps Direct and single read-only Turns free of staged Work activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-uncluttered-activity-"));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "uncluttered-activity",
    storageProfile: "ephemeral",
  });
  const activities: string[] = [];
  let modelCalls = 0;
  writeFileSync(join(root, "weather.txt"), "sunny\n");
  try {
    const runtime = createRuntime({
      root,
      dbPath,
      stores,
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          activities.push(update.summary);
        },
      },
      modelRound: scriptedModelRound([
        (request) => {
          modelCalls += 1;
          expect(request.messages[0]?.content).toContain("인사해 주세요");
          return { text: "안녕하세요!", toolCalls: [] };
        },
        (request) => {
          modelCalls += 1;
          expect(request.messages[0]?.content).toContain("weather.txt");
          return toolResponse([
            toolCall("uncluttered-read-1", "read_file", { path: "weather.txt" }),
          ], "저장된 날씨 한 줄을 확인합니다.");
        },
        (request) => {
          modelCalls += 1;
          expect(lastToolOutput(request, "read_file"))
            .toMatchObject({ content: "sunny\n" });
          return { text: "저장된 날씨는 sunny입니다.", toolCalls: [] };
        },
      ]),
    });

    expect(await runtime.runTurn(command(
      root,
      "uncluttered-direct-turn",
      "인사해 주세요.",
      "uncluttered-direct-session",
    ))).toMatchObject({ kind: "delivered", content: "안녕하세요!" });
    expect(await runtime.runTurn(command(
      root,
      "uncluttered-simple-turn",
      "weather.txt의 한 줄을 알려 주세요.",
      "uncluttered-simple-session",
    ))).toMatchObject({
      kind: "delivered",
      content: "저장된 날씨는 sunny입니다.",
    });
    expect(modelCalls).toBe(3);
    expect(activities).toEqual([]);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createRuntime(input: {
  root: string;
  dbPath: string;
  stores: ReturnType<typeof openBtccSqliteStores>;
  modelRound: ModelRoundPort;
  progress?: BtccTurnProgressObserver;
}) {
  return createGuidedTurnRuntime({
    admission: input.stores.admission,
    turns: input.stores.turns,
    messages: input.stores.messages,
    committedSuccessorReadiness: input.stores.committedSuccessorReadiness,
    ...(input.progress ? { progress: input.progress } : {}),
    agent: createProductionGuidedTurnAgent({
      butlerHome: input.root,
      butlerData: input.root,
      appMessageDbPath: input.dbPath,
      contextDocuments: input.stores.contextDocuments,
      toolJournal: input.stores.guidedToolJournal,
      effectJournal: input.stores.guidedEffectJournal,
      durableWork: input.stores.durableWork,
      modelRound: input.modelRound,
    }),
  });
}

function command(
  root: string,
  turnId: string,
  content: string,
  sessionId = "durable-work-session",
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId,
    triggerKey: `message:${turnId}`,
    message: { messageId: `message:${turnId}`, content },
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
      baselineObservationScopeRefs: [`workspace:${root}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath: root,
      },
    },
  };
}

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

function lastToolResult(
  request: ModelRoundRequest,
  name: string,
): Record<string, unknown> {
  const message = messagesWithToolResults(request)
    .filter((candidate) => candidate.name === name)
    .at(-1);
  expect(message).toBeDefined();
  return JSON.parse(message!.content) as Record<string, unknown>;
}

function lastToolOutput(
  request: ModelRoundRequest,
  name: string,
): unknown {
  return lastToolResult(request, name).output;
}

function checkpointProgress(summaries: string[]): BtccTurnProgressObserver {
  return {
    stateChanged() {},
    phaseActivityChanged(update) {
      if (
        update.displayStage === "review" &&
        update.title === "리뷰 준비 확인"
      ) {
        summaries.push(update.summary);
      }
    },
  };
}

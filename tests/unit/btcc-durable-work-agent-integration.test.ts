import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BtccRunCommand,
  BtccTurnProgressObserver,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";
import { createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/guided-turn/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
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
      promptRunner: async (options) => {
        expect(options.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
          "replace_work_plan",
          "record_work_checkpoint",
          "record_work_review",
          "write_file",
        ]));
        expect(await call(options, "replace_work_plan", {
          objective: "Create and verify report.md",
          actions: [{
            action_key: "write_report",
            description: "Write the requested report",
            dependency_keys: [],
            effect: { capability: "write_file", target: "workspace:report.md" },
          }],
          checks: ["report.md contains the requested result"],
        })).toMatchObject({ ok: true, work: { status: "open" } });
        expect(await call(options, "record_work_review", {
          subject: "plan",
          verdict: "accept",
          summary: "The plan directly produces and checks the requested artifact.",
          corrections: [],
        })).toMatchObject({ ok: true });
        expect(await call(options, "write_file", {
          path: "report.md",
          content: "# Verified report\n\nThe durable artifact is ready.\n",
        })).toMatchObject({
          ok: true,
          effect: "workspace_file_write",
          effect_receipt: {
            capability: "write_file",
            target: "workspace:report.md",
          },
        });
        expect(await call(options, "record_work_checkpoint", {
          stage: "review",
          public_summary: "보고서를 작성하고 실제 파일을 확인했습니다.",
          next_step: "사용자 요청에 맞는지 최종 검토합니다.",
        })).toMatchObject({ ok: true });
        return "보고서를 작성하고 확인했습니다.";
      },
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
      promptRunner: async (options) => {
        continuationPrompt = options.prompt;
        expect(await call(options, "read_file", {
          path: "report.md",
        })).toMatchObject({ content: expect.stringContaining("Verified report") });
        expect(await call(options, "record_work_review", {
          subject: "result",
          verdict: "accept",
          summary: "The requested file exists and contains the verified report.",
          corrections: [],
        })).toMatchObject({ ok: true, work: { status: "completed" } });
        return "이전 작업을 이어 최종 검토까지 마쳤습니다.";
      },
    });

    expect(await runtime.runTurn(command(root, secondTurnId, "이어서 마무리해 주세요.")))
      .toMatchObject({
        kind: "delivered",
        content: "이전 작업을 이어 최종 검토까지 마쳤습니다.",
      });
    expect(continuationPrompt).toContain("## Current Work");
    expect(continuationPrompt).toContain(
      "Original request: 조사 결과를 report.md로 만들고 확인해 주세요.",
    );
    expect(continuationPrompt).toContain("Result (write_file, completed)");
    expect(continuationPrompt).not.toContain("guided-work-");

    const completed = await secondStores.durableWork.boundWorkForTurn(secondTurnId);
    expect(completed).toMatchObject({
      status: "completed",
      currentPlan: { revision: 1 },
      latestPlanReview: { subject: "plan", verdict: "accept" },
      latestResultReview: { subject: "result", verdict: "accept" },
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
      promptRunner: async (options) => {
        const plan = await call(options, "replace_work_plan", {
          objective: "Prepare a resumable report",
          actions: [{
            action_key: "prepare",
            description: "Prepare and verify the report",
            dependency_keys: [],
          }],
          checks: ["The report is verified"],
        }) as { work?: { work_id?: string } };
        originalWorkId = plan.work?.work_id ?? "";
        await call(options, "record_work_checkpoint", {
          stage: "execution",
          public_summary: "보고서를 준비하고 있습니다.",
          next_step: "남은 내용을 작성하고 검증합니다.",
        });
        releaseStarted();
        return await new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener("abort", async () => {
            try {
              await call(options, "record_work_review", {
                subject: "result",
                verdict: "accept",
                summary: "This late review must not be recorded after Stop.",
                corrections: [],
              });
              postStopReview = "recorded";
            } catch {
              postStopReview = "fenced";
            }
            reject(new Error("aborted"));
          }, {
            once: true,
          });
        });
      },
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
      promptRunner: async (options) => {
        prompt = options.prompt;
        await call(options, "replace_work_plan", {
          start_new: false,
          objective: "Prepare a resumable report",
          actions: [{
            action_key: "prepare",
            description: "Prepare and verify the report",
            dependency_keys: [],
          }],
          checks: ["The report is verified"],
        });
        return "중지된 작업 기록을 확인했고 이어서 진행할 수 있습니다.";
      },
    });

    expect(await runtime.runTurn(command(
      root,
      resumedTurnId,
      "아까 중지한 작업을 이어가 주세요.",
    ))).toMatchObject({ kind: "delivered" });
    expect(prompt).toContain("Original request: 긴 보고서를 작성해 주세요.");
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
      promptRunner: async (options) => {
        const opened = await call(options, "replace_work_plan", {
          objective: "Read source.txt and report the observed fact",
          actions: [{
            action_key: "read_source",
            description: "Read the source file",
            dependency_keys: [],
          }],
          checks: ["The reported fact matches source.txt"],
        }) as { work?: { work_id?: string } };
        workId = opened.work?.work_id ?? "";
        return "작업 기록을 준비했습니다.";
      },
    });
    await originRuntime.runTurn(command(
      root,
      originTurnId,
      "source.txt를 확인하고 결과를 알려 주세요.",
    ));

    let directPrompt = "";
    const directRuntime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      promptRunner: async (options) => {
        directPrompt = options.prompt;
        return "별개의 간단한 질문에는 바로 답합니다.";
      },
    });
    expect(await directRuntime.runTurn(command(
      root,
      directTurnId,
      "별개의 간단한 질문입니다.",
    ))).toMatchObject({ kind: "delivered" });
    expect(directPrompt).toContain("## Current Work");
    expect(await firstStores.durableWork.boundWorkForTurn(directTurnId)).toBeNull();

    const interruptedRuntime = createRuntime({
      root,
      dbPath,
      stores: firstStores,
      promptRunner: async (options) => {
        expect(await call(options, "read_file", { path: "source.txt" }))
          .toMatchObject({ content: "durable observed fact\n" });
        throw new Error("provider disconnected after the committed tool result");
      },
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
    const resumedRuntime = createRuntime({
      root,
      dbPath,
      stores: resumedStores,
      promptRunner: async (options) => {
        nextPrompt = options.prompt;
        return "이전 도구 결과를 확인했습니다.";
      },
    });
    await resumedRuntime.runTurn(command(
      root,
      nextTurnId,
      "방금 확인한 결과를 이어서 알려 주세요.",
    ));
    expect(nextPrompt).toContain("Result (read_file, completed)");
    expect(nextPrompt).toContain("durable observed fact");
    expect(await resumedStores.durableWork.boundWorkForTurn(nextTurnId)).toBeNull();
    expect((await resumedStores.durableWork.loadContext({
      turnId: nextTurnId,
      sessionId: "durable-work-session",
    }))?.work.resultRefs).toHaveLength(1);
  } finally {
    resumedStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid Work bookkeeping is ordinary feedback and a corrected Plan can still deliver", async () => {
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
      promptRunner: async (options) => {
        expect(await call(options, "record_work_checkpoint", {
          stage: "execution",
          public_summary: "파일을 작성합니다.",
          next_step: "결과를 확인합니다.",
        })).toMatchObject({
          ok: false,
          error: { code: "work_update_rejected" },
        });
        expect(await call(options, "write_file", {
          path: "answer.txt",
          content: "actual result\n",
        })).toMatchObject({
          ok: false,
          error: { code: "effect_work_required" },
        });
        expect(await call(options, "replace_work_plan", {
          objective: "Create answer.txt",
          actions: [{
            action_key: "write_answer",
            description: "Write the requested answer file",
            dependency_keys: [],
            effect: {
              capability: "write_file",
              target: "workspace:answer.txt",
            },
          }],
          checks: ["answer.txt contains the requested result"],
        })).toMatchObject({ ok: true });
        expect(await call(options, "record_work_review", {
          subject: "plan",
          verdict: "accept",
          summary: "The exact file target matches the request.",
          corrections: [],
        })).toMatchObject({ ok: true });
        expect(await call(options, "write_file", {
          path: "answer.txt",
          content: "actual result\n",
        })).toMatchObject({ ok: true, effect: "workspace_file_write" });
        return "요청하신 파일을 실제로 작성했습니다.";
      },
    });

    expect(await runtime.runTurn(command(root, turnId, "answer.txt를 만들어 주세요.")))
      .toMatchObject({
        kind: "delivered",
        content: "요청하신 파일을 실제로 작성했습니다.",
      });
    expect(readFileSync(join(root, "answer.txt"), "utf8")).toBe("actual result\n");
    expect(await stores.durableWork.boundWorkForTurn(turnId)).toMatchObject({
      status: "open",
      latestPlanReview: { verdict: "accept" },
    });
    expect((await stores.turns.findTurn(turnId))?.route).toBe("managed");
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
      promptRunner: async (options) => {
        prompt = options.prompt;
        expect(await call(options, "read_file", { path: "legacy-source.txt" }))
          .toMatchObject({ content: "fact carried from the R2 task\n" });
        return "R2에서 열려 있던 작업과 현재 파일을 확인해 이어서 처리했습니다.";
      },
    });

    expect(await runtime.runTurn(command(
      root,
      turnId,
      "이전 작업을 이어서 처리해 주세요.",
      "session-fixture",
    ))).toMatchObject({ kind: "delivered" });
    expect(prompt).toContain("## Current Work");
    expect(prompt).toContain("Original request: Start the four-task Program");
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

function createRuntime(input: {
  root: string;
  dbPath: string;
  stores: ReturnType<typeof openBtccSqliteStores>;
  promptRunner: NonNullable<Parameters<typeof createProductionGuidedTurnAgent>[0]["promptRunner"]>;
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
      promptRunner: input.promptRunner,
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

async function call(
  options: Parameters<NonNullable<Parameters<
    typeof createProductionGuidedTurnAgent
  >[0]["promptRunner"]>>[0],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return options.executeTool({
    name,
    args,
    rawArguments: JSON.stringify(args),
  });
}

function checkpointProgress(summaries: string[]): BtccTurnProgressObserver {
  return {
    stateChanged() {},
    phaseActivityChanged(update) {
      summaries.push(update.summary);
    },
  };
}

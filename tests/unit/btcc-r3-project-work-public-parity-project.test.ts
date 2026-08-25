import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CapturingModelRound,
  finalText,
  guidedToolRows,
  inspectOfficialWork,
  latestToolPayload,
  PublicParityHarness,
  semanticRowCounts,
  tool,
  toolBatch,
  turnIdFrom,
  workIdFrom,
} from "./btcc-r3-project-work-public-parity-harness.ts";

const harnesses: PublicParityHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

test("real differing-ID App path initializes only the exact Ledger root and exposes every B1 mutation across restarts", async () => {
  const harness = track(new PublicParityHarness("project-b1"));
  const project = await harness.createProject({
    displayName: "Project B1 parity",
    ledgerProjectId: "ledger-project-b1-parity",
  });
  const ledgerRoot = harness.ledgerRoot(project.ledgerProjectId);
  expect(project.appProjectId).not.toBe(project.ledgerProjectId);
  expect(existsSync(ledgerRoot)).toBe(false);

  let workId = "";
  const started = await harness.runTurn({
    chatId: project.sessionId,
    text: "Start the durable public parity Work.",
    beforeDispatch(envelope) {
      expect(envelope.appTurnContext?.project).toMatchObject({
        id: project.appProjectId,
        ledgerProjectId: project.ledgerProjectId,
        workspacePath: project.workspacePath,
      });
      expect(existsSync(ledgerRoot)).toBe(false);
    },
    steps: [
      tool("b1-start", "start_work", {
        objective: "Prove every B1 operation through the real App path",
      }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("b1-plan", "replace_work_plan", {
          objective: "Prove every B1 operation through the real App path",
          actions: [{
            action_key: "verify_public_fact",
            description: "Read and validate the public path fact",
            dependency_keys: [],
          }],
          checks: ["The observed fact is attached and reviewed"],
        });
      },
      finalText("The Work is planned but needs a closeout declaration."),
      finalText("The runtime must settle this Turn open."),
    ],
  });
  expect(started.summary).toMatchObject({ handled: 1, failed: 0, interrupted: 0 });
  expect(workId).not.toBe("");
  expect(existsSync(join(ledgerRoot, "project.json"))).toBe(true);
  expect(existsSync(join(ledgerRoot, "ledger.jsonl"))).toBe(true);
  expect(existsSync(harness.ledgerRoot(project.appProjectId))).toBe(false);
  const afterStart = await inspectOfficialWork(ledgerRoot, workId);
  expect(afterStart).toMatchObject({
    semanticStatus: "open",
    officialStatus: "in_progress",
    planCount: 1,
    closeoutCount: 1,
    dispositionCount: 1,
    bindingCount: 1,
  });

  const continued = await runOpenTurn(harness, project.sessionId, workId, [
    tool("b1-continue", "continue_work", { work_id: workId }),
  ]);
  expect(latestToolPayload(continued.model.requests.at(-1)!, "continue_work"))
    .toMatchObject({ output: { work: { work_id: workId } } });
  await runOpenTurn(harness, project.sessionId, workId, [
    tool("b1-plan-review", "record_work_review", {
      subject: "plan",
      verdict: "accept",
      summary: "The plan directly proves the requested public path.",
      corrections: [],
      action_updates: [{ action_key: "verify_public_fact", status: "active" }],
    }),
  ]);
  await runOpenTurn(harness, project.sessionId, workId, [
    tool("b1-read", "read_file", { requests: [{ path: "public-fact.txt" }] }),
  ]);
  await runOpenTurn(harness, project.sessionId, workId, [
    tool("b1-checkpoint", "record_work_checkpoint", {
      action_updates: [{ action_key: "verify_public_fact", status: "done" }],
      public_summary: "The exact public fact was observed.",
      next_step: "Review the result and completion.",
    }),
  ]);
  const afterExplicitCheckpoint = await inspectOfficialWork(ledgerRoot, workId);
  const persistedExplicitCheckpoint = afterExplicitCheckpoint.children.find(({ body }) =>
    body.schema === "butler.btcc-project-work-checkpoint.v1" &&
    body.checkpoint?.publicSummary === "The exact public fact was observed.",
  );
  expect(afterExplicitCheckpoint.checkpointCount).toBeGreaterThan(0);
  expect(afterExplicitCheckpoint.manifest.latestCheckpointRevisionId).toBe(
    persistedExplicitCheckpoint?.record.id,
  );
  expect(persistedExplicitCheckpoint?.body.checkpoint).toMatchObject({
    checkpointRevisionId: persistedExplicitCheckpoint?.record.id,
    revision: afterExplicitCheckpoint.manifest.checkpointRevision,
    stage: afterExplicitCheckpoint.manifest.currentStage,
  });
  await runOpenTurn(harness, project.sessionId, workId, [
    tool("b1-result-review", "record_work_review", {
      subject: "result",
      verdict: "accept",
      summary: "The attached native result supports the objective.",
      corrections: [],
    }),
  ]);

  const completed = await harness.runTurn({
    chatId: project.sessionId,
    text: "Validate and close the persisted Work.",
    steps: [
      toolBatch([
        {
          id: "b1-completion-review",
          name: "record_work_review",
          arguments: {
            subject: "completion",
            verdict: "accept",
            summary: "The whole Work satisfies the original objective.",
            corrections: [],
          },
        },
        {
          id: "b1-complete",
          name: "record_work_disposition",
          arguments: {
            work_id: workId,
            disposition: "completed",
            summary: "All requested public parity evidence is complete.",
            action_updates: [{ action_key: "verify_public_fact", status: "done" }],
          },
        },
      ]),
      finalText("The completion review is current and no completion metadata is fabricated."),
    ],
  });
  expect(completed.summary).toMatchObject({ handled: 1, interrupted: 0 });

  const official = await inspectOfficialWork(ledgerRoot, workId);
  expect(official).toMatchObject({
    semanticStatus: "completed",
    officialStatus: "review",
    planCount: 1,
    checkpointCount: 13,
    resultCount: 1,
    reviewCount: 3,
  });
  expect(official.dispositionCount).toBeGreaterThanOrEqual(4);
  expect(official.bindingCount).toBeGreaterThanOrEqual(7);
  expect(official.closeoutCount).toBeGreaterThanOrEqual(1);
  const explicitCheckpoint = official.children.filter(({ body }) =>
    body.schema === "butler.btcc-project-work-checkpoint.v1",
  ).find(({ body }) =>
    body.checkpoint?.publicSummary === "The exact public fact was observed.",
  );
  expect(explicitCheckpoint?.body.checkpoint).toMatchObject({
    actionProgress: [{ actionKey: "verify_public_fact", status: "done" }],
    nextStep: "Review the result and completion.",
  });
  const currentCheckpointId = official.manifest.latestCheckpointRevisionId;
  expect(currentCheckpointId).toMatch(/^guided-checkpoint-/u);
  const currentCheckpoint = official.children.find(({ record, body }) =>
    record.id === currentCheckpointId &&
    body.schema === "butler.btcc-project-work-checkpoint.v1",
  );
  expect(currentCheckpoint?.body.checkpoint).toMatchObject({
    checkpointRevisionId: currentCheckpointId,
    revision: official.manifest.checkpointRevision,
    stage: official.manifest.currentStage,
  });
  expect(official.manifest.scope).toEqual({
    appProjectId: project.appProjectId,
    ledgerProjectId: project.ledgerProjectId,
  });
  expect(official.manifest).not.toHaveProperty("acceptance");
  expect(official.manifest).not.toHaveProperty("validation");
  expect(official.manifest).not.toHaveProperty("report");
  expect(official.manifest).not.toHaveProperty("completionGateIssues");
  expect(official.officialStatus).not.toBe("done");
  expect(existsSync(join(ledgerRoot, "tasks"))
    ? readdirSync(join(ledgerRoot, "tasks"))
    : []).toEqual([]);

  const db = harness.runtimeDb({ readonly: true });
  try {
    expect(semanticRowCounts(db)).toMatchObject({
      works: 1,
      plans: 0,
      checkpoints: 0,
      reviews: 0,
      dispositions: 0,
      results: 1,
    });
    expect(guidedToolRows(db).map((row) => row.tool_name)).toEqual(
      expect.arrayContaining([
        "start_work",
        "continue_work",
        "replace_work_plan",
        "record_work_checkpoint",
        "record_work_review",
        "record_work_disposition",
        "read_file",
      ]),
    );
  } finally {
    db.close();
  }
}, 30_000);

test("one real App Turn physically replays one canonical occurrence and rejects conflicting evidence without a write", async () => {
  const harness = track(new PublicParityHarness("replay-abandon"));
  const project = await harness.createProject({
    displayName: "Replay and abandon",
    ledgerProjectId: "ledger-replay-abandon",
  });
  let firstWorkId = "";
  let turnId = "";
  let planCallId = "";
  let initialPlanPayload: Record<string, any> | undefined;
  let laterCheckpointPayload: Record<string, any> | undefined;
  let replayPayload: Record<string, any> | undefined;
  let conflictPayload: Record<string, any> | undefined;
  let beforeReplayCardinality: ProjectCardinality | undefined;
  let afterReplayCardinality: ProjectCardinality | undefined;
  let ledgerBeforeReplay = "";
  let ledgerAfterReplay = "";
  let ledgerBeforeConflict = "";
  let ledgerAfterConflict = "";
  let callbackError = "";
  const first = await harness.runTurn({
    chatId: project.sessionId,
    text: "Start the first replayable Work.",
    beforeDispatch(envelope) {
      turnId = envelope.routingHints?.turnId ?? "";
    },
    steps: [
      tool("replay-start", "start_work", { objective: "First replayable Work" }),
      (request) => {
        firstWorkId = workIdFrom(request, "start_work");
        return tool("replay-plan", "replace_work_plan", {
          objective: "First replayable Work",
          actions: [{ action_key: "one", dependency_keys: [] }],
          checks: ["one"],
        });
      },
      (request) => {
        initialPlanPayload = latestToolPayload(request, "replace_work_plan");
        expect(initialPlanPayload).toMatchObject({
          output: { work: { work_id: firstWorkId, current_stage: "planning" } },
        });
        return tool("replay-later-checkpoint", "record_work_checkpoint", {
          action_updates: [{ action_key: "one", status: "active" }],
          public_summary: "Later canonical progress distinguishes replay.",
          next_step: "Replay the older Plan occurrence.",
        });
      },
      async (request) => {
        laterCheckpointPayload = latestToolPayload(request, "record_work_checkpoint");
        try {
          planCallId = harness.forgetGuidedToolCall(turnId, "replace_work_plan");
        } catch (error) {
          callbackError = error instanceof Error ? error.message : String(error);
          return finalText();
        }
        beforeReplayCardinality = await projectCardinality(harness, project.ledgerProjectId, {
          workId: firstWorkId,
          operationId: planCallId,
        });
        ledgerBeforeReplay = readLedger(harness.ledgerRoot(project.ledgerProjectId));
        return tool("replay-plan", "replace_work_plan", {
          objective: "First replayable Work",
          actions: [{ action_key: "one", dependency_keys: [] }],
          checks: ["one"],
        });
      },
      async (request) => {
        replayPayload = latestToolPayload(request, "replace_work_plan");
        ledgerAfterReplay = readLedger(harness.ledgerRoot(project.ledgerProjectId));
        afterReplayCardinality = await projectCardinality(
          harness,
          project.ledgerProjectId,
          { workId: firstWorkId, operationId: planCallId },
        );
        ledgerBeforeConflict = readLedger(harness.ledgerRoot(project.ledgerProjectId));
        harness.tamperProjectOccurrenceRequest(planCallId);
        expect(harness.forgetGuidedToolCall(turnId, "replace_work_plan")).toBe(planCallId);
        return tool("replay-plan", "replace_work_plan", {
          objective: "First replayable Work",
          actions: [{ action_key: "one", dependency_keys: [] }],
          checks: ["one"],
        });
      },
      (request) => {
        conflictPayload = latestToolPayload(request, "replace_work_plan");
        ledgerAfterConflict = readLedger(harness.ledgerRoot(project.ledgerProjectId));
        return finalText();
      },
      finalText(),
    ],
  });
  expect(first.summary).toMatchObject({ handled: 0, interrupted: 1 });
  expect(turnIdFrom(first.accepted.body)).toBe(turnId);
  expect(initialPlanPayload).toMatchObject({
    output: { work: { actions: [{ action_key: "one", status: "pending" }] } },
  });
  expect(laterCheckpointPayload).toMatchObject({
    output: { work: { actions: [{ action_key: "one", status: "active" }] } },
  });
  expect(replayPayload).toMatchObject({
    ok: true,
    output: {
      work: {
        work_id: firstWorkId,
        current_stage: "planning",
        actions: [{ action_key: "one", status: "active" }],
      },
    },
  });
  expect(replayPayload?.output?.work?.actions).not.toEqual(
    initialPlanPayload?.output?.work?.actions,
  );
  expect(replayPayload?.output?.work).toEqual(laterCheckpointPayload?.output?.work);
  expect(beforeReplayCardinality).toMatchObject({
    occurrenceCount: 1,
    planCount: 1,
    checkpointCount: 3,
  });
  expect(beforeReplayCardinality?.recordCount).toBeGreaterThan(0);
  expect(beforeReplayCardinality?.ledgerEntryCount).toBeGreaterThan(0);
  expect(ledgerAfterReplay).toBe(ledgerBeforeReplay);
  expect(afterReplayCardinality).toEqual(beforeReplayCardinality);
  expect(conflictPayload).toMatchObject({
    ok: false,
    error: { code: "work_update_rejected" },
  });
  expect(callbackError).toBe("");
  expect(ledgerAfterConflict).toBe(ledgerBeforeConflict);
  const afterConflict = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    firstWorkId,
  );
  expect(afterConflict.planCount).toBe(1);
  expect(afterConflict.checkpointCount).toBe(3);
}, 30_000);

test("a later real App Work atomically abandons the prior Project semantic authority", async () => {
  const harness = track(new PublicParityHarness("abandon"));
  const project = await harness.createProject({
    displayName: "Abandon prior",
    ledgerProjectId: "ledger-abandon-prior",
  });
  let priorId = "";
  await harness.runTurn({
    chatId: project.sessionId,
    text: "Start prior Work.",
    steps: [
      tool("prior-start", "start_work", { objective: "Prior Work" }),
      (request) => {
        priorId = workIdFrom(request, "start_work");
        return tool("prior-plan", "replace_work_plan", {
          objective: "Prior Work",
          actions: [{ action_key: "prior", dependency_keys: [] }],
          checks: ["prior"],
        });
      },
      finalText(),
      finalText(),
    ],
  });
  let replacementId = "";
  const replacement = await harness.runTurn({
    chatId: project.sessionId,
    text: "Start unrelated replacement Work.",
    steps: [
      tool("replacement-start", "start_work", { objective: "Replacement Work" }),
      (request) => {
        replacementId = workIdFrom(request, "start_work");
        return tool("replacement-plan", "replace_work_plan", {
          objective: "Replacement Work",
          actions: [{ action_key: "replacement", dependency_keys: [] }],
          checks: ["replacement"],
        });
      },
      finalText(),
      finalText(),
    ],
  });
  expect(replacement.summary).toMatchObject({ handled: 1, interrupted: 0 });
  expect(replacementId).not.toBe(priorId);
  const prior = await inspectOfficialWork(harness.ledgerRoot(project.ledgerProjectId), priorId);
  expect(prior.semanticStatus).toBe("abandoned");
  expect(prior.index.records.filter((record) => record.kind === "work")).toHaveLength(2);
}, 30_000);

test("two real App sessions race one Project CAS and publish exactly one semantic Work", async () => {
  const harness = track(new PublicParityHarness("two-writer-cas"));
  const project = await harness.createProject({
    displayName: "Two writer CAS",
    ledgerProjectId: "ledger-two-writer-cas",
  });
  const secondSession = await harness.createProjectSession(
    project.appProjectId,
    "Second CAS writer",
  );
  expect((await harness.postMessage({
    chatId: project.sessionId,
    text: "Start writer one.",
  })).response.status).toBe(202);
  expect((await harness.postMessage({
    chatId: secondSession,
    text: "Start writer two.",
  })).response.status).toBe(202);

  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new CapturingModelRound([
    async () => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
      return tool("cas-writer-one", "start_work", { objective: "CAS writer one" });
    },
    async () => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
      return tool("cas-writer-two", "start_work", { objective: "CAS writer two" });
    },
    finalText(),
    finalText(),
    finalText(),
    finalText(),
  ]);
  const summary = await harness.dispatch(model, { limit: 2, maxConcurrentSessions: 2 });
  expect(summary).toMatchObject({ claimed: 2, handled: 2, interrupted: 0 });
  const toolPayloads = model.toolMessages
    .filter((item) => item.name === "start_work")
    .map((item) => JSON.parse(item.content));
  expect(toolPayloads.filter((payload) => payload.ok === true)).toHaveLength(1);
  expect(toolPayloads.filter((payload) => payload.ok === false)).toHaveLength(1);
  const official = await inspectOfficialWork(harness.ledgerRoot(project.ledgerProjectId));
  expect(official.index.records.filter((record) => record.kind === "work")).toHaveLength(1);
  const db = harness.runtimeDb({ readonly: true });
  try {
    expect(semanticRowCounts(db).works).toBe(1);
  } finally {
    db.close();
  }
}, 30_000);

async function runOpenTurn(
  harness: PublicParityHarness,
  chatId: string,
  workId: string,
  operationSteps: Parameters<PublicParityHarness["runTurn"]>[0]["steps"],
) {
  openTurnIndex += 1;
  const result = await harness.runTurn({
    chatId,
    text: `Execute public B1 operation ${openTurnIndex}.`,
    steps: [
      ...operationSteps,
      tool(`public-open-${openTurnIndex}`, "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "This bounded public operation is complete; the Work remains open.",
        remaining_actions: ["Continue the next public parity operation"],
        next_condition: "The next public App Turn arrives.",
      }),
      finalText(),
    ],
  });
  if (result.summary.interrupted > 0) {
    throw new Error(`public_open_turn_interrupted:${JSON.stringify({
      tools: result.model.toolMessages,
      processing: harness.queueRecords("processing"),
    })}`);
  }
  expect(result.summary).toMatchObject({ handled: 1, failed: 0, interrupted: 0 });
  return result;
}

let openTurnIndex = 0;

function readLedger(root: string): string {
  return readFileSync(join(root, "ledger.jsonl"), "utf8");
}

type ProjectCardinality = {
  occurrenceCount: number;
  planCount: number;
  checkpointCount: number;
  recordCount: number;
  ledgerEntryCount: number;
};

async function projectCardinality(
  harness: PublicParityHarness,
  ledgerProjectId: string,
  input: { workId: string; operationId?: string },
): Promise<ProjectCardinality> {
  const root = harness.ledgerRoot(ledgerProjectId);
  const official = await inspectOfficialWork(root, input.workId);
  const occurrenceDirectory = join(
    harness.root,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  );
  const occurrenceCount = input.operationId
    ? readdirSync(occurrenceDirectory).filter((name) => {
        const occurrence = JSON.parse(
          readFileSync(join(occurrenceDirectory, name), "utf8"),
        ) as { operationIdentity?: { id?: string } };
        return occurrence.operationIdentity?.id === input.operationId;
      }).length
    : 0;
  return {
    occurrenceCount,
    planCount: official.planCount,
    checkpointCount: official.checkpointCount,
    recordCount: official.index.records.length,
    ledgerEntryCount: readLedger(root).trim().split("\n").length,
  };
}

function track(harness: PublicParityHarness): PublicParityHarness {
  harnesses.push(harness);
  return harness;
}

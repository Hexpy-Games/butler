import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkActionUpdates,
  allowedNextWorkStages,
  createDurableWorkService,
  dispositionMaterialFingerprint,
  type DurableWorkView,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  createProjectWorkStore,
  reconcileProjectLedgerRecordUpdates,
  type ProjectWorkOperationIdentity,
  type ProjectWorkRuntimeProjection,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { loadProjectLedgerCore } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import { canonicalProjectWorkChildBody } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-child-codec.ts";
import { captureMaterialSnapshot } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-material-snapshot.ts";
import { projectWorkRecordId } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-json.ts";
import { publishProjectWorkRecords } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-publication.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("public service maps Work, Plan, checkpoint, Reviews, and completed disposition to official records", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "start-1",
    objective: "Ship the exact adapter",
  });
  expect(started.status).toBe("open");

  const planned = await service.replacePlan({
    ...scope,
    mutationCallId: "plan-1",
    objective: "Ship the exact adapter",
    actions: [
      { actionKey: "implement", description: "Implement", dependencyKeys: [] },
    ],
    checks: ["focused test passes"],
  });
  expect(planned.currentPlan?.planRevisionId).toMatch(/^guided-plan-/);
  expect(planned.latestCheckpoint).toMatchObject({
    revision: 2,
    stage: "planning",
  });

  const planReviewed = await service.recordReview({
    ...scope,
    mutationCallId: "review-plan-1",
    subject: "plan",
    verdict: "accept",
    summary: "Plan accepted",
    corrections: [],
  });
  expect(planReviewed.currentStage).toBe("execution");
  const checkpointed = await service.recordCheckpoint({
    ...scope,
    mutationCallId: "checkpoint-1",
    actionUpdates: [{ actionKey: "implement", status: "done" }],
    publicSummary: "Implemented",
    nextStep: "Review result",
  });
  expect(checkpointed.actionProgress).toEqual([
    { actionKey: "implement", status: "done" },
  ]);
  const resultReviewed = await service.recordReview({
    ...scope,
    mutationCallId: "review-result-1",
    subject: "result",
    verdict: "accept",
    summary: "Result accepted",
    corrections: [],
    actionUpdates: [{
      actionKey: "implement",
      status: "done",
      note: "Detailed result review note",
    }],
  });
  expect(resultReviewed.currentStage).toBe("validation");
  const completion = await service.recordReview({
    ...scope,
    mutationCallId: "review-completion-1",
    subject: "completion",
    verdict: "accept",
    summary: "Validation accepted",
    corrections: [],
    actionUpdates: [{
      actionKey: "implement",
      status: "done",
      note: "Short completion note",
    }],
  });
  const completed = await service.recordDisposition({
    ...scope,
    mutationCallId: "disposition-1",
    workId: completion.workId,
    disposition: "completed",
    summary: "Complete",
    actionUpdates: [{ actionKey: "implement", status: "done" }],
    evidenceRefs: [],
  });
  expect(completed.status).toBe("completed");

  const index = fixture.core.buildIndex(fixture.projectRoot);
  const work = index.records.find((record) => record.id === completed.workId)!;
  expect(work.kind).toBe("work");
  expect(work.status).toBe("review");
  expect(index.records.filter((record) => record.kind === "task")).toHaveLength(
    0,
  );
  const planRecord = index.records.find(
    (record) => record.id === planned.currentPlan!.planRevisionId,
  )!;
  const planBody = JSON.parse(
    fixture.core.readRecordBody(
      fixture.core.projectPath(fixture.projectRoot, planRecord.path),
    )!,
  );
  expect(planBody.plan.actions).toEqual([
    { actionKey: "implement", description: "Implement", dependencyKeys: [] },
  ]);
  expect(
    index.records.some(
      (record) =>
        record.id === completed.latestDisposition?.dispositionRevisionId,
    ),
  ).toBe(true);
});

test("binding, closeout, replay/current view, required ports, and abandonment are method-correct", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const first = fixture.scope("turn-1");
  const started = await service.startWork({
    ...first,
    mutationCallId: "start-replay",
    objective: "Replay safely",
  });
  const eventsAfterStart = readFileSync(
    join(fixture.projectRoot, "ledger.jsonl"),
    "utf8",
  );
  const replay = await service.startWork({
    ...first,
    mutationCallId: "start-replay",
    objective: "Replay safely",
  });
  expect(replay).toEqual(started);
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(
    eventsAfterStart,
  );
  await expect(
    service.startWork({
      ...first,
      mutationCallId: "start-replay",
      objective: "Different intent",
    }),
  ).rejects.toMatchObject({
    code: "project_ledger_effect_occurrence_conflict",
  });
  const beforeBoundSwitch = readFileSync(
    join(fixture.projectRoot, "ledger.jsonl"),
    "utf8",
  );
  await expect(
    service.startWork({
      ...first,
      mutationCallId: "start-switch-forbidden",
      objective: "Must not replace binding",
    }),
  ).rejects.toThrow("project_work_turn_already_bound");
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(
    beforeBoundSwitch,
  );
  await expect(
    service.replacePlan({
      ...first,
      mutationCallId: "plan-switch-forbidden",
      startNew: true,
      objective: "Must not switch",
      actions: [{ actionKey: "x", description: "x", dependencyKeys: [] }],
      checks: ["never written"],
    }),
  ).rejects.toThrow("project_work_turn_already_bound");

  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "continue",
  });
  const second = fixture.scope("turn-2");
  expect((await service.bindOpenWork(second, started.workId))?.workId).toBe(
    started.workId,
  );
  expect(
    (
      await service.continueWork({
        ...second,
        mutationCallId: "continue-2",
        workId: started.workId,
      })
    ).workId,
  ).toBe(started.workId);
  expect((await service.boundWorkForTurn("turn-2"))?.workId).toBe(
    started.workId,
  );
  expect(
    await service.claimCloseoutCorrection({
      ...second,
      workId: started.workId,
    }),
  ).toBe(true);
  expect(
    await service.claimCloseoutCorrection({
      ...second,
      workId: started.workId,
    }),
  ).toBe(false);
  await expect(service.importOpenLegacyWork(second)).rejects.toThrow(
    "project_work_legacy_import_required",
  );
  expect(
    (
      await service.attachToolResult({
        ...second,
        mutationCallId: "result-1",
        toolCallId: "tool-1",
      })
    ).workId,
  ).toBe(started.workId);
  expect(fixture.resultCalls).toEqual(["tool-1"]);
  expect((await service.loadContext(second))?.originalRequest.content).toBe(
    "start request",
  );
  fixture.runtime.originals.set("turn-3", {
    turnId: "turn-3",
    messageId: "message-turn-3",
    content: "new work",
  });
  const replacement = await service.startWork({
    ...fixture.scope("turn-3"),
    mutationCallId: "start-after-prior",
    objective: "New current Work",
  });
  expect(fixture.runtime.works.get(started.workId)?.status).toBe("abandoned");
  expect(fixture.runtime.observations.at(-1)).toEqual([
    started.workId,
    replacement.workId,
  ]);
  expect((await service.loadContext(second))?.work.status).toBe("abandoned");
  expect((await service.abandonBoundWorkForTurn("turn-2"))?.status).toBe(
    "abandoned",
  );
  const afterAbandonment = readFileSync(
    join(fixture.projectRoot, "ledger.jsonl"),
    "utf8",
  );
  expect((await service.abandonBoundWorkForTurn("turn-2"))?.status).toBe(
    "abandoned",
  );
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(
    afterAbandonment,
  );
});

test("binding identity distinguishes omitted and explicit expected Work across replay", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const started = await service.startWork({
    ...fixture.scope("turn-1"),
    mutationCallId: "binding-identity-start",
    objective: "Bind caller identity exactly",
  });
  const omitted = fixture.scope("turn-omitted");
  expect((await service.bindOpenWork(omitted))?.workId).toBe(started.workId);
  expect((await service.bindOpenWork(omitted))?.workId).toBe(started.workId);
  await expect(
    service.bindOpenWork(omitted, started.workId),
  ).rejects.toMatchObject({
    code: "project_ledger_effect_occurrence_conflict",
  });

  const explicit = fixture.scope("turn-explicit");
  expect((await service.bindOpenWork(explicit, started.workId))?.workId).toBe(
    started.workId,
  );
  expect((await service.bindOpenWork(explicit, started.workId))?.workId).toBe(
    started.workId,
  );
  await expect(service.bindOpenWork(explicit)).rejects.toMatchObject({
    code: "project_ledger_effect_occurrence_conflict",
  });
});

test("strict official metadata binds body status and rejects completion metadata", async () => {
  const statusFixture = await createFixture();
  const statusService = createDurableWorkService(
    createProjectWorkStore(statusFixture.adapterInput),
  );
  const statusScope = statusFixture.scope("turn-1");
  const started = await statusService.startWork({
    ...statusScope,
    mutationCallId: "metadata-status-start",
    objective: "Keep official status exact",
  });
  statusFixture.core.updateRecord(statusFixture.projectRoot, {
    id: started.workId,
    kind: "work",
    status: "blocked",
  });
  statusFixture.core.writeIndex(statusFixture.projectRoot);
  await expect(statusService.loadContext(statusScope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );

  const completionFixture = await createFixture();
  const completionService = createDurableWorkService(
    createProjectWorkStore(completionFixture.adapterInput),
  );
  const completionScope = completionFixture.scope("turn-1");
  const completionWork = await completionService.startWork({
    ...completionScope,
    mutationCallId: "metadata-completion-start",
    objective: "Reject fabricated completion",
  });
  completionFixture.core.updateRecord(completionFixture.projectRoot, {
    id: completionWork.workId,
    kind: "work",
    status: "review",
    acceptance: "fabricated acceptance",
    validation: "fabricated validation",
    review: "fabricated review",
    report: "fabricated report",
  });
  completionFixture.core.updateRecord(completionFixture.projectRoot, {
    id: completionWork.workId,
    kind: "work",
    status: "done",
  });
  completionFixture.core.writeIndex(completionFixture.projectRoot);
  await expect(completionService.loadContext(completionScope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );

  const childFixture = await createFixture();
  const childService = createDurableWorkService(
    createProjectWorkStore(childFixture.adapterInput),
  );
  const childScope = childFixture.scope("turn-1");
  await childService.startWork({
    ...childScope,
    mutationCallId: "metadata-child-start",
    objective: "Keep immutable children active",
  });
  const planned = await childService.replacePlan({
    ...childScope,
    mutationCallId: "metadata-child-plan",
    objective: "Keep immutable children active",
    actions: [{ actionKey: "a", description: "A", dependencyKeys: [] }],
    checks: ["active"],
  });
  childFixture.core.updateRecord(childFixture.projectRoot, {
    id: planned.currentPlan!.planRevisionId,
    kind: "plan",
    status: "done",
  });
  childFixture.core.writeIndex(childFixture.projectRoot);
  await expect(childService.loadContext(childScope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
});

test("historical immutable Plan proof rejects body and metadata reseal", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "immutable-proof-start",
    objective: "Authenticate immutable Plan",
  });
  const planned = await service.replacePlan({
    ...scope,
    mutationCallId: "immutable-proof-plan",
    objective: "Authenticate immutable Plan",
    actions: [{ actionKey: "proof", description: "Proof", dependencyKeys: [] }],
    checks: ["immutable"],
  });
  const planId = planned.currentPlan!.planRevisionId;
  const planRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    id: planId,
    kind: "plan",
  });
  const body = JSON.parse(
    fixture.core.readRecordBody(planRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: planId,
    kind: "plan",
    title: "Resealed historical Plan",
    body: stableJson({
      ...body,
      plan: { ...body.plan, createdAt: "2026-08-25T12:00:00.000Z" },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const restarted = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  await expect(restarted.loadContext(scope)).rejects.toThrow();
});

test("legacy v1 evidence blocks v2 admission before any Project Work write", async () => {
  const fixture = await createFixture();
  const mutationCallId = "legacy-v1-conflict";
  const occurrenceId = createHash("sha256")
    .update(
      JSON.stringify({
        effectKey: mutationCallId,
        projectRoot: fixture.projectRoot,
        schema: "butler.btcc-project-ledger-effect.v1",
      }),
    )
    .digest("hex");
  const legacyRoot = join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
  );
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, `${occurrenceId}.json`), "{}", "utf8");
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  await expect(
    service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId,
      objective: "Must not coexist with legacy evidence",
    }),
  ).rejects.toMatchObject({ code: "project_ledger_effect_uncertain" });
  expect(
    fixture.core.buildIndex(fixture.projectRoot).records.some(
      (record) => record.kind === "work",
    ),
  ).toBe(false);
});

test("required disposition port owns completed replay, reopen, open, and blocked safety", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "status-start",
    objective: "Status policy",
  });
  const completed = await service.recordDisposition({
    ...scope,
    mutationCallId: "status-complete",
    workId: started.workId,
    disposition: "completed",
    summary: "Complete",
  });
  const completedEvents = ledgerText(fixture.projectRoot);
  expect(
    await service.recordDisposition({
      ...scope,
      mutationCallId: "status-complete",
      workId: started.workId,
      disposition: "completed",
      summary: "Complete",
    }),
  ).toEqual(completed);
  expect(ledgerText(fixture.projectRoot)).toBe(completedEvents);
  expect((await service.loadContext(scope))?.work).toEqual(completed);
  fixture.runtime.currentViewNext = true;
  const beforeCurrentView = readFileSync(
    join(fixture.projectRoot, "ledger.jsonl"),
    "utf8",
  );
  const occurrencesBeforeCurrentView = occurrenceCount(fixture.butlerData);
  const unchanged = await service.recordDisposition({
    ...scope,
    mutationCallId: "runtime-current-view",
    workId: started.workId,
    disposition: "open",
    summary: "Runtime check",
    expectedMaterialFingerprint: dispositionMaterialFingerprint(completed),
    runtimeOwnedOpenGeneration: { version: 1 },
  });
  expect(unchanged.status).toBe("completed");
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(
    beforeCurrentView,
  );
  expect(occurrenceCount(fixture.butlerData)).toBe(
    occurrencesBeforeCurrentView,
  );
  const reopened = await service.recordDisposition({
    ...scope,
    mutationCallId: "runtime-reopen",
    workId: started.workId,
    disposition: "open",
    summary: "Reopen",
    remainingActions: ["Continue"],
    expectedMaterialFingerprint: dispositionMaterialFingerprint(completed),
    runtimeOwnedOpenGeneration: { version: 1 },
  });
  expect(reopened.status).toBe("open");
  const blocked = await service.recordDisposition({
    ...scope,
    mutationCallId: "status-blocked",
    workId: started.workId,
    disposition: "blocked",
    summary: "Blocked",
    remainingActions: ["Wait"],
    nextCondition: "Dependency arrives",
  });
  expect(blocked.status).toBe("blocked");
});

test("public B1 semantic derivation yields to exact historical occurrence replay", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "semantic-replay-start",
    objective: "Replay historical commands",
  });
  const firstPlanInput = {
    ...scope,
    mutationCallId: "semantic-replay-plan-1",
    objective: "First objective",
    governingRefs: ["SPEC-SEMANTIC-REPLAY"],
    actions: [
      { actionKey: "base", description: "Base", dependencyKeys: [] },
      {
        actionKey: "first",
        description: "First",
        dependencyKeys: ["base"],
      },
    ],
    checks: ["first"],
  };
  await service.replacePlan(firstPlanInput);
  const checkpointInput = {
    ...scope,
    mutationCallId: "semantic-replay-checkpoint",
    actionUpdates: [{ actionKey: "first", status: "done" as const }],
    publicSummary: "First completed",
    nextStep: "Review",
  };
  await service.recordCheckpoint(checkpointInput);
  const firstReviewInput = {
    ...scope,
    mutationCallId: "semantic-replay-review-1",
    subject: "plan" as const,
    verdict: "revise" as const,
    summary: "First needs revision",
    corrections: ["Replace Plan"],
  };
  await service.recordReview(firstReviewInput);
  const secondPlanInput = {
    ...scope,
    mutationCallId: "semantic-replay-plan-2",
    objective: "Second objective",
    actions: [{ actionKey: "second", description: "Second", dependencyKeys: [] }],
    checks: ["second"],
  };
  const secondPlan = await service.replacePlan(secondPlanInput);
  const firstPlanId = projectWorkRecordId("plan", firstPlanInput.mutationCallId);
  const firstPlanRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "plan",
    id: firstPlanId,
  });
  const firstPlanBody = JSON.parse(
    fixture.core.readRecordBody(firstPlanRecord.filePath)!,
  );
  for (const plan of [
    {
      ...firstPlanBody.plan,
      actions: firstPlanBody.plan.actions.map(
        (action: Record<string, unknown>, index: number) =>
          index === 1 ? { ...action, description: "Tampered" } : action,
      ),
    },
    {
      ...firstPlanBody.plan,
      actions: firstPlanBody.plan.actions.map(
        (action: Record<string, unknown>, index: number) =>
          index === 1 ? { ...action, dependencyKeys: [] } : action,
      ),
    },
    { ...firstPlanBody.plan, checks: ["tampered"] },
    { ...firstPlanBody.plan, governingRefs: ["SPEC-TAMPERED"] },
    { ...firstPlanBody.plan, originTurnId: "turn-unbound" },
  ]) {
    fixture.core.updateRecord(fixture.projectRoot, {
      id: firstPlanId,
      kind: "plan",
      body: resealProjectWorkChild({ ...firstPlanBody, plan }),
    });
    fixture.core.writeIndex(fixture.projectRoot);
    const tamperedEvents = ledgerText(fixture.projectRoot);
    await expect(service.replacePlan(firstPlanInput)).rejects.toThrow();
    expect(ledgerText(fixture.projectRoot)).toBe(tamperedEvents);
  }
  fixture.core.updateRecord(fixture.projectRoot, {
    id: firstPlanId,
    kind: "plan",
    body: stableJson(firstPlanBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const checkpointId = projectWorkRecordId(
    "checkpoint",
    checkpointInput.mutationCallId,
  );
  const checkpointRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: checkpointId,
  });
  const checkpointBody = JSON.parse(
    fixture.core.readRecordBody(checkpointRecord.filePath)!,
  );
  for (const actionProgress of [
    checkpointBody.checkpoint.actionProgress.map(
      (item: Record<string, unknown>, index: number) =>
        index === 0 ? { ...item, status: "active" } : item,
    ),
    [...checkpointBody.checkpoint.actionProgress].reverse(),
  ]) {
    fixture.core.updateRecord(fixture.projectRoot, {
      id: checkpointId,
      kind: "reference",
      body: resealProjectWorkChild({
        ...checkpointBody,
        checkpoint: { ...checkpointBody.checkpoint, actionProgress },
      }),
    });
    fixture.core.writeIndex(fixture.projectRoot);
    const checkpointEvents = ledgerText(fixture.projectRoot);
    await expect(service.recordCheckpoint(checkpointInput)).rejects.toThrow();
    expect(ledgerText(fixture.projectRoot)).toBe(checkpointEvents);
  }
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson(checkpointBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const reviewExitId = projectWorkRecordId(
    "checkpoint",
    `${firstReviewInput.mutationCallId}\0review-exit`,
  );
  const reviewExitRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: reviewExitId,
  });
  const reviewExitBody = JSON.parse(
    fixture.core.readRecordBody(reviewExitRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: reviewExitId,
    kind: "reference",
    body: resealProjectWorkChild({
      ...reviewExitBody,
      checkpoint: {
        ...reviewExitBody.checkpoint,
        actionProgress: reviewExitBody.checkpoint.actionProgress.map(
          (item: Record<string, unknown>, index: number) =>
            index === 0 ? { ...item, status: "active" } : item,
        ),
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const reviewEvents = ledgerText(fixture.projectRoot);
  await expect(service.recordReview(firstReviewInput)).rejects.toThrow();
  expect(ledgerText(fixture.projectRoot)).toBe(reviewEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: reviewExitId,
    kind: "reference",
    body: stableJson(reviewExitBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const afterSecondPlan = ledgerText(fixture.projectRoot);
  expect((await service.recordCheckpoint(checkpointInput)).currentPlan).toEqual(
    secondPlan.currentPlan,
  );
  expect(ledgerText(fixture.projectRoot)).toBe(afterSecondPlan);
  await service.recordReview({
    ...scope,
    mutationCallId: "semantic-replay-review-2",
    subject: "plan",
    verdict: "accept",
    summary: "Second accepted",
    corrections: [],
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "semantic-replay-result",
    subject: "result",
    verdict: "accept",
    summary: "Result accepted",
    corrections: [],
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "semantic-replay-completion",
    subject: "completion",
    verdict: "accept",
    summary: "Completion accepted",
    corrections: [],
  });
  const completed = await service.recordDisposition({
    ...scope,
    mutationCallId: "semantic-replay-disposition",
    workId: secondPlan.workId,
    disposition: "completed",
    summary: "Done",
  });
  const terminalEvents = ledgerText(fixture.projectRoot);
  expect(await service.recordReview(firstReviewInput)).toEqual(completed);
  expect(await service.replacePlan(secondPlanInput)).toEqual(completed);
  expect(ledgerText(fixture.projectRoot)).toBe(terminalEvents);
});

test("multi-Work replacePlan replay selects the immutable child parent Work", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const firstScope = fixture.scope("turn-1");
  const first = await service.startWork({
    ...firstScope,
    mutationCallId: "multi-work-first",
    objective: "Terminal head",
  });
  await service.recordDisposition({
    ...firstScope,
    mutationCallId: "multi-work-complete",
    workId: first.workId,
    disposition: "completed",
    summary: "Complete first",
  });
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "new implicit work",
  });
  const replacementInput = {
    ...fixture.scope("turn-2"),
    mutationCallId: "multi-work-plan",
    objective: "Implicit replacement Work",
    actions: [{ actionKey: "new", description: "New", dependencyKeys: [] }],
    checks: ["new"],
  };
  const replacement = await service.replacePlan(replacementInput);
  fixture.runtime.originals.set("turn-3", {
    turnId: "turn-3",
    messageId: "message-turn-3",
    content: "later head",
  });
  await service.startWork({
    ...fixture.scope("turn-3"),
    mutationCallId: "multi-work-later",
    objective: "Later head",
  });
  const events = ledgerText(fixture.projectRoot);
  const replay = await service.replacePlan(replacementInput);
  expect(replay.workId).toBe(replacement.workId);
  expect(replay.status).toBe("abandoned");
  expect(ledgerText(fixture.projectRoot)).toBe(events);
});

test("observed binding and abandonment require their exact durable receipt", async () => {
  const missing = await createFixture();
  const missingService = createDurableWorkService(
    createProjectWorkStore(missing.adapterInput),
  );
  const first = missing.scope("turn-1");
  const started = await missingService.startWork({
    ...first,
    mutationCallId: "receipt-start",
    objective: "Require receipt",
  });
  const occurrenceRoot = join(
    missing.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  );
  const startReceipt = readdirSync(occurrenceRoot).map((name) =>
    join(occurrenceRoot, name),
  )[0]!;
  rmSync(startReceipt);
  await expect(
    missingService.bindOpenWork(first, started.workId),
  ).rejects.toThrow("project_work_occurrence_receipt_missing");

  const corrupt = await createFixture();
  const corruptService = createDurableWorkService(
    createProjectWorkStore(corrupt.adapterInput),
  );
  const corruptScope = corrupt.scope("turn-1");
  const corruptStarted = await corruptService.startWork({
    ...corruptScope,
    mutationCallId: "receipt-corrupt-start",
    objective: "Reject corrupt receipt",
  });
  const corruptRoot = join(
    corrupt.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  );
  const corruptReceipt = join(corruptRoot, readdirSync(corruptRoot)[0]!);
  writeFileSync(corruptReceipt, "{\"privatePath\":\"/secret/path\"}\n");
  await expect(
    corruptService.bindOpenWork(corruptScope, corruptStarted.workId),
  ).rejects.toMatchObject({ code: "project_ledger_effect_uncertain" });

  const abandoned = await createFixture();
  const abandonedService = createDurableWorkService(
    createProjectWorkStore(abandoned.adapterInput),
  );
  const abandonedFirst = await abandonedService.startWork({
    ...abandoned.scope("turn-1"),
    mutationCallId: "receipt-abandon-first",
    objective: "First",
  });
  abandoned.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "second",
  });
  await abandonedService.startWork({
    ...abandoned.scope("turn-2"),
    mutationCallId: "receipt-abandon-second",
    objective: "Second",
  });
  const abandonmentRoot = join(
    abandoned.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  );
  for (const name of readdirSync(abandonmentRoot)) {
    const path = join(abandonmentRoot, name);
    const body = JSON.parse(readFileSync(path, "utf8"));
    if (body.operationIdentity.id === "receipt-abandon-second") rmSync(path);
  }
  await expect(
    abandonedService.abandonBoundWorkForTurn(
      abandonedFirst.origin.turnId,
    ),
  ).rejects.toThrow("project_work_occurrence_receipt_missing");
});

test("durable targets recover projection after promotion and old start replay cannot regress the head", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const firstInput = {
    ...fixture.scope("turn-1"),
    mutationCallId: "projection-first",
    objective: "First head",
  };
  const first = await service.startWork(firstInput);
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "replace head",
  });
  const secondInput = {
    ...fixture.scope("turn-2"),
    mutationCallId: "projection-second",
    objective: "Second head",
  };
  fixture.runtime.observationFailures = 1;
  await expect(service.startWork(secondInput)).rejects.toMatchObject({
    code: "project_ledger_effect_uncertain",
  });
  const promotedEvents = ledgerText(fixture.projectRoot);
  const second = await service.startWork(secondInput);
  expect(ledgerText(fixture.projectRoot)).toBe(promotedEvents);
  expect(fixture.runtime.heads.get("session-1")).toBe(second.workId);
  expect(fixture.runtime.observations.at(-1)).toEqual([
    first.workId,
    second.workId,
  ]);

  const oldReplay = await service.startWork(firstInput);
  expect(oldReplay.status).toBe("abandoned");
  expect(fixture.runtime.heads.get("session-1")).toBe(second.workId);
  expect(fixture.runtime.observations.at(-1)).toEqual([
    first.workId,
    second.workId,
  ]);
  expect(ledgerText(fixture.projectRoot)).toBe(promotedEvents);
});

test("required projection port filesystem errors are safely masked", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  fixture.runtime.observationError = Object.assign(
    new Error("EACCES: /private/project/projection.json"),
    { code: "EACCES" },
  );
  let failure: unknown;
  try {
    await service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId: "projection-eacces",
      objective: "Mask projection path",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "project_ledger_effect_uncertain",
    message: "The Project Ledger publication state could not be verified safely.",
  });
  expect(String(failure)).not.toContain("/private/project");

  const attachmentService = createDurableWorkService(
    createProjectWorkStore({
      ...fixture.adapterInput,
      resultRuntime: {
        ...fixture.adapterInput.resultRuntime,
        readCommittedResult() {
          throw Object.assign(new Error("EACCES: /private/result.json"), {
            code: "EACCES",
          });
        },
      },
    }),
  );
  let attachmentFailure: unknown;
  try {
    await attachmentService.attachToolResult({
      ...fixture.scope("turn-1"),
      mutationCallId: "attachment-eacces",
      toolCallId: "tool-eacces",
    });
  } catch (error) {
    attachmentFailure = error;
  }
  expect(attachmentFailure).toMatchObject({
    code: "project_ledger_effect_uncertain",
    message: "The Project Ledger publication state could not be verified safely.",
  });
  expect(String(attachmentFailure)).not.toContain("/private/result");
});

test("canonical relation admission prevents a second head while runtime projection is stale", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  await service.startWork({
    ...fixture.scope("turn-1"),
    mutationCallId: "canonical-first",
    objective: "First",
  });
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "second",
  });
  const secondInput = {
    ...fixture.scope("turn-2"),
    mutationCallId: "canonical-second",
    objective: "Second",
  };
  fixture.runtime.observationFailures = 1;
  await expect(service.startWork(secondInput)).rejects.toMatchObject({
    code: "project_ledger_effect_uncertain",
  });
  const afterPromotion = ledgerText(fixture.projectRoot);
  await expect(
    service.startWork({
      ...fixture.scope("turn-2"),
      mutationCallId: "canonical-same-turn-switch",
      objective: "Forbidden switch",
    }),
  ).rejects.toThrow("project_work_turn_already_bound");
  expect(ledgerText(fixture.projectRoot)).toBe(afterPromotion);

  fixture.runtime.originals.set("turn-3", {
    turnId: "turn-3",
    messageId: "message-turn-3",
    content: "third",
  });
  const third = await service.startWork({
    ...fixture.scope("turn-3"),
    mutationCallId: "canonical-third",
    objective: "Third",
  });
  expect(canonicalHeadIds(fixture)).toEqual([third.workId]);
  const replayedSecond = await service.startWork(secondInput);
  expect(replayedSecond.status).toBe("abandoned");
  expect(canonicalHeadIds(fixture)).toEqual([third.workId]);
  expect(fixture.runtime.heads.get("session-1")).toBe(third.workId);
});

test("current Session reads ignore unrelated malformed Project Work", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "session-local-read",
    objective: "Read only the current Session Work",
  });
  fixture.core.createWork(fixture.projectRoot, {
    id: "unrelated-malformed-work",
    title: "Unrelated malformed Work",
    status: "proposed",
    spec: "SPEC-BTCC-R3-WORK-LEDGER-SCOPE",
    body: stableJson({
      schema: "unrelated.invalid-work.v1",
      sessionId: "another-session",
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  expect((await service.loadContext(scope))?.work.workId).toBe(started.workId);
  expect((await service.boundWorkForTurn("turn-1"))?.workId).toBe(started.workId);
});

test("Project Ledger Tasks under a managed Work remain outside BTCC child validation", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "task-sibling-start",
    objective: "Continue after ordinary Project Ledger bookkeeping",
  });
  fixture.core.createTask(fixture.projectRoot, {
    id: "task-sibling",
    work: started.workId,
    title: "Ordinary Project Ledger Task",
    status: "todo",
  });
  fixture.core.writeIndex(fixture.projectRoot);

  expect((await service.loadContext(scope))?.work.workId).toBe(started.workId);
  expect((await service.replacePlan({
    ...scope,
    mutationCallId: "task-sibling-plan",
    objective: "Continue after ordinary Project Ledger bookkeeping",
    actions: [{
      actionKey: "continue",
      description: "Continue BTCC Work",
      dependencyKeys: [],
    }],
    checks: [],
  })).currentPlan?.actions).toHaveLength(1);
});

test("ready disposition resumes its durable candidate without recomputing runtime semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-ready-disposition-"));
  roots.push(root);
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      import.meta.path,
      "-t",
      "ready disposition crash child",
    ],
    cwd: process.cwd(),
    env: { ...process.env, BTCC_READY_DISPOSITION_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(91);
  const fixture = await createFixture(root, false);
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.boundWorkForTurn("turn-1");
  const command = {
    ...scope,
    mutationCallId: "ready-disposition",
    workId: started!.workId,
    disposition: "completed" as const,
    summary: "Original prepared meaning",
  };
  const preparations = fixture.runtime.dispositionPreparations;
  const captures = fixture.runtime.materialCaptures;
  fixture.runtime.currentViewNext = true;
  fixture.runtime.materialFingerprintOverride = "d".repeat(64);
  const recovered = await service.recordDisposition(command);
  expect(recovered.status).toBe("completed");
  expect(recovered.latestDisposition?.summary).toBe(
    "Original prepared meaning",
  );
  expect(fixture.runtime.dispositionPreparations).toBe(preparations);
  expect(fixture.runtime.materialCaptures).toBe(captures);
  expect(recovered.latestDisposition?.materialFingerprint).not.toBe(
    "d".repeat(64),
  );
});

test("ready disposition crash child", async () => {
  const root = process.env.BTCC_READY_DISPOSITION_ROOT;
  if (!root) return;
  const fixture = await createFixture(root, true);
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "ready-disposition-start",
    objective: "Resume exact disposition",
  });
  fixture.core.promoteProjectLedgerPublication = (() => {
    process.exit(91);
  }) as typeof fixture.core.promoteProjectLedgerPublication;
  await service.recordDisposition({
    ...scope,
    mutationCallId: "ready-disposition",
    workId: started.workId,
    disposition: "completed",
    summary: "Original prepared meaning",
  });
});

test("disposition authority supplies the exact effect-aware fingerprint and durable proof", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "effect-start",
    objective: "Capture effect material",
  });
  fixture.runtime.materialFingerprintOverride = "e".repeat(64);
  fixture.runtime.effectProof = {
    effectWatermark: "effect-watermark-7",
    effectBlockers: [
      {
        blockerId: "blocker-1",
        sourceTurnId: "turn-1",
        capabilitySha256: "a".repeat(64),
        targetSha256: "b".repeat(64),
        detailSha256: "c".repeat(64),
      },
    ],
  };
  await service.continueWork({
    ...scope,
    mutationCallId: "effect-continue",
    workId: started.workId,
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "effect-plan",
    objective: "Capture effect material",
    actions: [{ actionKey: "effect", description: "Effect", dependencyKeys: [] }],
    checks: ["proof retained"],
  });
  await service.recordCheckpoint({
    ...scope,
    mutationCallId: "effect-checkpoint",
    publicSummary: "Still effect-aware",
    nextStep: "Complete",
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "effect-plan-review",
    subject: "plan",
    verdict: "accept",
    summary: "Effect-aware review",
    corrections: [],
  });
  const completed = await service.recordDisposition({
    ...scope,
    mutationCallId: "effect-complete",
    workId: started.workId,
    disposition: "completed",
    summary: "Effect-safe complete",
  });
  expect(completed.latestDisposition?.materialFingerprint).toBe("e".repeat(64));
  const record = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: completed.latestDisposition!.dispositionRevisionId,
  });
  const body = JSON.parse(fixture.core.readRecordBody(record.filePath)!);
  expect(body.materialSnapshot).toMatchObject(fixture.runtime.effectProof);
  expect(body.materialSnapshot.materialFingerprint).toBe("e".repeat(64));
  expect((await service.boundWorkForTurn("turn-1"))?.status).toBe("completed");
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "new head",
  });
  await service.startWork({
    ...fixture.scope("turn-2"),
    mutationCallId: "effect-next-head",
    objective: "Move the Session head",
  });
  expect((await service.boundWorkForTurn("turn-1"))?.status).toBe("completed");
  const completedManifest = JSON.parse(
    fixture.core.readRecordBody(
      fixture.core.resolveRecord(fixture.projectRoot, {
        kind: "work",
        id: completed.workId,
      }).filePath,
    )!,
  );
  expect(completedManifest.materialFingerprint).toBe("e".repeat(64));
  fixture.core.updateRecord(fixture.projectRoot, {
    id: completed.latestDisposition!.dispositionRevisionId,
    kind: "reference",
    body: stableJson({
      ...body,
      materialSnapshot: {
        ...body.materialSnapshot,
        materialFingerprint: "d".repeat(64),
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const events = ledgerText(fixture.projectRoot);
  await expect(service.boundWorkForTurn("turn-1")).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(events);
});

test("prepared domain errors remain typed while unknown preparation errors are masked", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  fixture.runtime.originals.delete("turn-1");
  await expect(
    service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId: "unknown-prepare",
      objective: "Mask internals",
    }),
  ).rejects.toMatchObject({ code: "project_ledger_effect_uncertain" });
  expect(
    fixture.core
      .buildIndex(fixture.projectRoot)
      .records.filter((record) => record.kind === "work"),
  ).toHaveLength(0);

  fixture.runtime.originalFailure = Object.assign(
    new Error("EACCES: /private/secret-project"),
    { code: "EACCES" },
  );
  await expect(
    service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId: "coded-unknown-prepare",
      objective: "Mask coded internals",
    }),
  ).rejects.toMatchObject({ code: "project_ledger_effect_uncertain" });
  fixture.runtime.originalFailure = null;

  fixture.runtime.originalFailure = new Error(
    "project_work_unknown_private_path_/Users/secret",
  );
  await expect(
    service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId: "prefixed-unknown-prepare",
      objective: "Mask prefixed internals",
    }),
  ).rejects.toMatchObject({ code: "project_ledger_effect_uncertain" });
  fixture.runtime.originalFailure = null;

  fixture.runtime.originals.set("turn-1", {
    turnId: "wrong-turn",
    messageId: "message-turn-1",
    content: "wrong identity",
  });
  await expect(
    service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId: "typed-prepare",
      objective: "Preserve domain code",
    }),
  ).rejects.toMatchObject({ code: "project_work_origin_turn_mismatch" });
  expect(
    fixture.core
      .buildIndex(fixture.projectRoot)
      .records.filter((record) => record.kind === "work"),
  ).toHaveLength(0);
});

test("missing and inaccessible project metadata are masked without path disclosure", async () => {
  for (const mode of ["missing", "directory"] as const) {
    const fixture = await createFixture();
    const projectFile = join(fixture.projectRoot, "project.json");
    rmSync(projectFile);
    if (mode === "directory") mkdirSync(projectFile);
    const service = createDurableWorkService(
      createProjectWorkStore(fixture.adapterInput),
    );
    let failure: unknown;
    try {
      await service.startWork({
        ...fixture.scope("turn-1"),
        mutationCallId: `metadata-${mode}`,
        objective: "Mask project path",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "project_ledger_effect_uncertain",
      message: "The Project Ledger publication state could not be verified safely.",
    });
    expect(String(failure)).not.toContain(fixture.projectRoot);
  }
});

test("two fresh writers use predecessor CAS and the loser writes no Work", async () => {
  const fixture = await createFixture();
  const left = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const right = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const settled = await Promise.allSettled([
    left.startWork({
      ...scope,
      mutationCallId: "writer-left",
      objective: "Left",
    }),
    right.startWork({
      ...scope,
      mutationCallId: "writer-right",
      objective: "Right",
    }),
  ]);
  expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
  expect(
    fixture.core
      .buildIndex(fixture.projectRoot)
      .records.filter((record) => record.kind === "work"),
  ).toHaveLength(1);
});

test("ready publication recovery resumes through the public adapter and returns current view", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const render = fixture.core.render.bind(fixture.core);
  let faulted = false;
  fixture.core.render = ((...args: Parameters<typeof fixture.core.render>) => {
    if (!faulted) {
      faulted = true;
      throw new Error("test_ready_fault");
    }
    return render(...args);
  }) as typeof fixture.core.render;
  const input = {
    ...scope,
    mutationCallId: "ready-recovery",
    objective: "Recover ready",
  };
  await expect(service.startWork(input)).rejects.toThrow();
  fixture.core.render = render;
  const recovered = await service.startWork(input);
  expect(recovered.objective).toBe("Recover ready");
  const events = readFileSync(
    join(fixture.projectRoot, "ledger.jsonl"),
    "utf8",
  );
  expect(await service.startWork(input)).toEqual(recovered);
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(
    events,
  );
});



test("strict reads require an exact observed receipt for every admitted attempt", async () => {
  const variants = [
    "missing",
    "corrupt",
    "prior",
    "publication",
    "attempt",
    "request",
    "base",
    "candidate",
    "status",
  ] as const;
  for (const variant of variants) {
    const fixture = await createFixture();
    const service = createDurableWorkService(
      createProjectWorkStore(fixture.adapterInput),
    );
    const operationId = `observed-receipt-${variant}`;
    await service.startWork({
      ...fixture.scope("turn-1"),
      mutationCallId: operationId,
      objective: `Verify ${variant} receipt`,
    });
    const found = occurrenceFor(fixture.butlerData, operationId);
    const attempt = found.occurrence.attempts.at(-1);
    const receiptPath = publicationReceiptPath(
      fixture.butlerData,
      attempt.publicationId,
    );
    if (variant === "missing") rmSync(receiptPath);
    else if (variant === "corrupt") writeFileSync(receiptPath, "{");
    else if (variant === "prior") {
      found.occurrence.attempts.push({ ...attempt, number: attempt.number + 1 });
      resealOccurrence(found.occurrence);
      writeFileSync(found.path, JSON.stringify(found.occurrence));
    } else {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (variant === "publication") receipt.publicationId = "a".repeat(64);
      else if (variant === "attempt") receipt.attemptNumber += 1;
      else if (variant === "request") receipt.requestSha256 = "b".repeat(64);
      else if (variant === "base") receipt.baseHead.sourceSha256 = "c".repeat(64);
      else if (variant === "candidate")
        receipt.candidateHead.projectRoot = `${fixture.projectRoot}-other`;
      else {
        receipt.status = "not_applied";
        delete receipt.candidateHead;
      }
      writeFileSync(receiptPath, JSON.stringify(receipt));
    }
    await expect(service.loadContext(fixture.scope("turn-1"))).rejects.toThrow(
      "project_work_managed_record_invalid",
    );
  }
});


test("historical observed receipts remain valid after the canonical head advances", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "historical-receipt-start",
    objective: "Keep historical evidence valid",
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "historical-receipt-plan",
    objective: "Keep historical evidence valid",
    actions: [{ actionKey: "advance", description: "Advance", dependencyKeys: [] }],
    checks: ["historical receipt remains exact"],
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "historical-receipt-review",
    subject: "plan",
    verdict: "accept",
    summary: "Advance the canonical head",
    corrections: [],
  });
  expect((await service.loadContext(scope))?.work.currentStage).toBe("execution");
});


test("legacy empty reconcile is uncertain before a missing occurrence is classified", async () => {
  const fixture = await createFixture();
  expect(
    await reconcileProjectLedgerRecordUpdates({
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      effectKey: "legacy-empty-reconcile",
      updates: [],
    }),
  ).toEqual({
    status: "uncertain",
    message: "The Project Ledger publication state could not be verified safely.",
  });
  expect(occurrenceCount(fixture.butlerData)).toBe(0);
});

test("related unknown-schema child fails closed without a write", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "unknown-schema-start",
    objective: "Reject unknown children",
  });
  fixture.core.createRecord(fixture.projectRoot, {
    project: fixture.projectRoot,
    kind: "reference",
    id: "unknown-managed-child",
    parentId: started.workId,
    title: "Unknown managed child",
    status: "active",
    spec: "SPEC-BTCC-R3-WORK-LEDGER-SCOPE",
    body: stableJson({
      schema: "butler.btcc-project-work-unknown.v1",
      workId: started.workId,
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const events = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(events);
});

test("managed body corruption and immutable identity conflict fail closed", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const work = await service.startWork({
    ...scope,
    mutationCallId: "start-corrupt",
    objective: "Fail closed",
  });
  const workPath = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "work",
    id: work.workId,
  }).filePath;
  const raw = readFileSync(workPath, "utf8");
  writeFileSync(
    workPath,
    raw.replace('"schema":"butler.btcc-project-work.v1"', '"schema":"corrupt"'),
  );
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
});

test("strict snapshot authenticates every managed child identity and bound origin", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "auth-start",
    objective: "Authenticate every child",
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "auth-plan",
    objective: "Authenticate every child",
    actions: [{ actionKey: "one", description: "One", dependencyKeys: [] }],
    checks: ["authentic"],
  });
  await service.recordCheckpoint({
    ...scope,
    mutationCallId: "auth-checkpoint",
    publicSummary: "Checkpoint",
    nextStep: "Review",
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "auth-review",
    subject: "plan",
    verdict: "accept",
    summary: "Accepted",
    corrections: [],
  });
  await service.claimCloseoutCorrection({ ...scope, workId: started.workId });
  const dispositionInput = {
    ...scope,
    mutationCallId: "auth-disposition",
    workId: started.workId,
    disposition: "blocked" as const,
    summary: "Blocked",
    remainingActions: ["Resume"],
    nextCondition: "Ready",
  };
  await service.recordDisposition(dispositionInput);

  const corruptAndReject = async (
    id: string,
    kind: "plan" | "reference",
    change: (body: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const record = fixture.core.resolveRecord(fixture.projectRoot, { id, kind });
    const original = JSON.parse(fixture.core.readRecordBody(record.filePath)!);
    fixture.core.updateRecord(fixture.projectRoot, {
      id,
      kind,
      body: stableJson(change(original)),
    });
    fixture.core.writeIndex(fixture.projectRoot);
    const events = ledgerText(fixture.projectRoot);
    await expect(service.loadContext(scope)).rejects.toThrow(
      "project_work_managed_record_invalid",
    );
    expect(ledgerText(fixture.projectRoot)).toBe(events);
    fixture.core.updateRecord(fixture.projectRoot, {
      id,
      kind,
      body: stableJson(original),
    });
    fixture.core.writeIndex(fixture.projectRoot);
  };
  const children = fixture.core
    .buildIndex(fixture.projectRoot)
    .records.filter(
      (record) => record.kind === "plan" || record.kind === "reference",
    )
    .map((record) => ({
      ...record,
      body: JSON.parse(
        fixture.core.readRecordBody(
          fixture.core.projectPath(fixture.projectRoot, record.path),
        )!,
      ),
    }));
  for (const child of children) {
    const key = child.body.plan
      ? "plan"
      : child.body.checkpoint
        ? "checkpoint"
        : child.body.review
          ? "review"
          : child.body.disposition
            ? "disposition"
            : child.body.binding
              ? "binding"
              : child.body.diagnostic
                ? "diagnostic"
                : null;
    if (!key) continue;
    const originKey = key === "binding" || key === "diagnostic" ? "turnId" : "originTurnId";
    await corruptAndReject(
      child.id,
      child.kind as "plan" | "reference",
      (body) => ({
        ...body,
        [key]: {
          ...(body[key] as Record<string, unknown>),
          [originKey]: "turn-unbound",
        },
      }),
    );
  }
  const checkpoint = children.find(
    (child) => child.body.checkpoint && child.body.checkpointIdentity === "auth-checkpoint",
  )!;
  await corruptAndReject(checkpoint.id, "reference", (body) => ({
    ...body,
    checkpointIdentity: `${(body.operationIdentity as Record<string, unknown>).id}\0unknown-role`,
  }));
  await corruptAndReject(checkpoint.id, "reference", (body) => ({
    ...body,
    operationIdentity: {
      ...(body.operationIdentity as Record<string, unknown>),
      id: "auth-checkpoint-tampered",
      mutationCallId: "auth-checkpoint-tampered",
    },
  }));
  const diagnostic = children.find((child) => child.body.diagnostic)!;
  await corruptAndReject(diagnostic.id, "reference", (body) => ({
    ...body,
    diagnostic: {
      ...(body.diagnostic as Record<string, unknown>),
      turnId: "turn-unbound",
    },
  }));
  const diagnosticRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
  });
  const diagnosticBody = JSON.parse(
    fixture.core.readRecordBody(diagnosticRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    spec: "SPEC-WRONG",
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    spec: "SPEC-BTCC-R3-WORK-LEDGER-SCOPE",
  });
  fixture.core.writeIndex(fixture.projectRoot);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    body: resealProjectWorkChild({
      ...diagnosticBody,
      schema: "butler.btcc-project-work-wrong.v1",
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    body: stableJson(diagnosticBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    body: stableJson({
      ...diagnosticBody,
      diagnostic: { ...diagnosticBody.diagnostic, turnId: "turn-unbound" },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(
    service.claimCloseoutCorrection({ ...scope, workId: started.workId }),
  ).rejects.toThrow("project_work_managed_record_invalid");
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    body: stableJson(diagnosticBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    parentId: "wrong-work",
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const wrongParentEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toMatchObject({
    code: "project_ledger_effect_uncertain",
  });
  expect(ledgerText(fixture.projectRoot)).toBe(wrongParentEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: diagnostic.id,
    kind: "reference",
    parentId: started.workId,
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const disposition = children.find((child) => child.body.disposition)!;
  const dispositionRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
  });
  const dispositionBody = JSON.parse(
    fixture.core.readRecordBody(dispositionRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
    body: resealProjectWorkChild({
      ...dispositionBody,
      disposition: { ...dispositionBody.disposition, summary: "Tampered" },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const dispositionEvents = ledgerText(fixture.projectRoot);
  await expect(service.recordDisposition(dispositionInput)).rejects.toThrow();
  expect(ledgerText(fixture.projectRoot)).toBe(dispositionEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
    body: stableJson(dispositionBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
    body: resealProjectWorkChild({
      ...dispositionBody,
      operationIdentity: {
        ...dispositionBody.operationIdentity,
        requestSha256: "f".repeat(64),
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.recordDisposition(dispositionInput)).rejects.toThrow();
  fixture.core.updateRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
    body: stableJson(dispositionBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
    body: resealProjectWorkChild({
      ...dispositionBody,
      disposition: {
        ...dispositionBody.disposition,
        materialFingerprint: "e".repeat(64),
      },
      materialSnapshot: {
        ...dispositionBody.materialSnapshot,
        materialFingerprint: "e".repeat(64),
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.recordDisposition(dispositionInput)).rejects.toThrow();
  fixture.core.updateRecord(fixture.projectRoot, {
    id: disposition.id,
    kind: "reference",
    body: stableJson(dispositionBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  expect((await service.loadContext(scope))?.work.workId).toBe(started.workId);
});

test("strict snapshot accepts stale historical Plan dependencies and fails closed when their identity is corrupt", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "history-start",
    objective: "Validate history",
  });
  const firstPlan = await service.replacePlan({
    ...scope,
    mutationCallId: "history-plan-1",
    objective: "First plan",
    actions: [{ actionKey: "one", description: "One", dependencyKeys: [] }],
    checks: ["one"],
  });
  const reviewed = await service.recordReview({
    ...scope,
    mutationCallId: "history-review-1",
    subject: "plan",
    verdict: "revise",
    summary: "First needs revision",
    corrections: ["Replace it"],
  });
  const secondPlan = await service.replacePlan({
    ...scope,
    mutationCallId: "history-plan-2",
    objective: "Second plan",
    actions: [{ actionKey: "two", description: "Two", dependencyKeys: [] }],
    checks: ["two"],
  });
  expect(secondPlan.currentPlan?.planRevisionId).not.toBe(
    firstPlan.currentPlan?.planRevisionId,
  );
  expect(secondPlan.latestPlanReview?.reviewRevisionId).toBe(
    reviewed.latestPlanReview?.reviewRevisionId,
  );
  expect((await service.loadContext(scope))?.work.currentPlan?.objective).toBe(
    "Second plan",
  );

  const currentPlan = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "plan",
    id: secondPlan.currentPlan!.planRevisionId,
  });
  const currentPlanBody = JSON.parse(
    fixture.core.readRecordBody(currentPlan.filePath)!,
  );
  for (const corruptPlan of [
    {
      ...currentPlanBody,
      plan: { ...currentPlanBody.plan, objective: "Wrong objective" },
    },
    {
      ...currentPlanBody,
      plan: {
        ...currentPlanBody.plan,
        actions: [
          { actionKey: "wrong", description: "Wrong", dependencyKeys: [] },
        ],
      },
    },
  ]) {
    fixture.core.updateRecord(fixture.projectRoot, {
      id: secondPlan.currentPlan!.planRevisionId,
      kind: "plan",
      body: stableJson(corruptPlan),
    });
    fixture.core.writeIndex(fixture.projectRoot);
    const beforeRead = ledgerText(fixture.projectRoot);
    await expect(service.loadContext(scope)).rejects.toThrow(
      "project_work_managed_record_invalid",
    );
    expect(ledgerText(fixture.projectRoot)).toBe(beforeRead);
  }
  fixture.core.updateRecord(fixture.projectRoot, {
    id: secondPlan.currentPlan!.planRevisionId,
    kind: "plan",
    body: stableJson(currentPlanBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const historicalPlan = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "plan",
    id: firstPlan.currentPlan!.planRevisionId,
  });
  const body = JSON.parse(fixture.core.readRecordBody(historicalPlan.filePath)!);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: firstPlan.currentPlan!.planRevisionId,
    kind: "plan",
    body: stableJson({
      ...body,
      operationIdentity: currentPlanBody.operationIdentity,
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const coordinatedReceiptEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(coordinatedReceiptEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: firstPlan.currentPlan!.planRevisionId,
    kind: "plan",
    body: stableJson(body),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: firstPlan.currentPlan!.planRevisionId,
    kind: "plan",
    body: stableJson({ ...body, workId: "wrong-work" }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const events = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(events);
});

test("strict snapshot decodes Result references and rejects sequence corruption without a write", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  const started = await service.startWork({
    ...scope,
    mutationCallId: "start-result-snapshot",
    objective: "Validate Result reference",
  });
  const withResult = await appendCanonicalResult(
    fixture,
    started,
    1,
    "2026-08-25T00:00:00.000Z",
  );
  const result = withResult.resultRefs[0]!;
  const resultRef = result.resultRef;
  const resultRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: resultRef,
  });
  const childBody = fixture.core.readRecordBody(resultRecord.filePath)!;
  const child = JSON.parse(childBody);
  expect((await service.loadContext(scope))?.work.resultRefs).toEqual([result]);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultRef,
    kind: "reference",
    body: stableJson({
      ...JSON.parse(childBody),
      result: { ...JSON.parse(childBody).result, sequence: 2 },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const events = readFileSync(
    join(fixture.projectRoot, "ledger.jsonl"),
    "utf8",
  );
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(
    events,
  );

  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultRef,
    kind: "reference",
    body: stableJson({
      ...child,
      result: { ...child.result, status: "failed", errorCode: "tool_failed" },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const failedEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(failedEvents);

  const { resultSha256: _removed, ...withoutSha } = child.result;
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultRef,
    kind: "reference",
    body: stableJson({ ...child, result: withoutSha }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const missingHashEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(missingHashEvents);
});

test("strict snapshot proves checkpoint windows and historical Review dependencies exactly", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "window-start",
    objective: "Validate windows",
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "window-plan",
    objective: "Validate windows",
    actions: [{ actionKey: "one", description: "One", dependencyKeys: [] }],
    checks: ["exact"],
  });
  let work = await service.recordReview({
    ...scope,
    mutationCallId: "window-plan-review",
    subject: "plan",
    verdict: "accept",
    summary: "Plan accepted",
    corrections: [],
  });
  work = await appendCanonicalResult(fixture, work, 1, "2026-08-24T00:00:01.000Z");
  await appendCanonicalResult(fixture, work, 2, "2026-08-24T00:00:02.000Z");
  await service.recordCheckpoint({
    ...scope,
    mutationCallId: "window-checkpoint",
    publicSummary: "Two results",
    nextStep: "Review",
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "window-result-review",
    subject: "result",
    verdict: "accept",
    summary: "Results accepted",
    corrections: [],
  });
  work = await service.recordReview({
    ...scope,
    mutationCallId: "window-completion-review",
    subject: "completion",
    verdict: "accept",
    summary: "Completion accepted",
    corrections: [],
  });
  work = await appendCanonicalResult(fixture, work, 3, "2026-08-23T00:00:00.000Z");
  expect((await service.loadContext(scope))?.work.resultRefs).toHaveLength(3);

  const checkpointId = work.latestCheckpoint!.checkpointRevisionId;
  const checkpointRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: checkpointId,
  });
  const checkpointBody = JSON.parse(
    fixture.core.readRecordBody(checkpointRecord.filePath)!,
  );
  const resultIds = work.resultRefs.map((item) => item.resultRef);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson({
      ...checkpointBody,
      checkpoint: {
        ...checkpointBody.checkpoint,
        referencedResultRefs: [resultIds[1], resultIds[0]],
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson(checkpointBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  for (const checkpoint of [
    { ...checkpointBody.checkpoint, planRevisionId: "wrong-plan" },
    { ...checkpointBody.checkpoint, stage: "validation" },
    {
      ...checkpointBody.checkpoint,
      actionProgress: [{ actionKey: "wrong", status: "pending" }],
    },
  ]) {
    fixture.core.updateRecord(fixture.projectRoot, {
      id: checkpointId,
      kind: "reference",
      body: stableJson({ ...checkpointBody, checkpoint }),
    });
    fixture.core.writeIndex(fixture.projectRoot);
    const checkpointEvents = ledgerText(fixture.projectRoot);
    await expect(service.loadContext(scope)).rejects.toThrow(
      "project_work_managed_record_invalid",
    );
    expect(ledgerText(fixture.projectRoot)).toBe(checkpointEvents);
  }
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson({
      ...checkpointBody,
      resultWindow: { ...checkpointBody.resultWindow, fromSequence: 1 },
      checkpoint: {
        ...checkpointBody.checkpoint,
        referencedResultRefs: [resultIds[1]],
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson(checkpointBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const resultReviewId = work.latestResultReview!.reviewRevisionId;
  const resultReviewRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: resultReviewId,
  });
  const resultReviewBody = JSON.parse(
    fixture.core.readRecordBody(resultReviewRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultReviewId,
    kind: "reference",
    body: stableJson({
      ...resultReviewBody,
      review: { ...resultReviewBody.review, boundResultRefs: [resultIds[0]] },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultReviewId,
    kind: "reference",
    body: stableJson(resultReviewBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const planReviewId = work.latestPlanReview!.reviewRevisionId;
  const planReviewRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: planReviewId,
  });
  const planReviewBody = JSON.parse(
    fixture.core.readRecordBody(planReviewRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultReviewId,
    kind: "reference",
    body: stableJson({
      ...resultReviewBody,
      review: {
        ...resultReviewBody.review,
        revision: planReviewBody.review.revision,
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const duplicateRevisionEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(duplicateRevisionEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultReviewId,
    kind: "reference",
    body: stableJson(resultReviewBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  for (const corruptResultReview of [
    {
      ...resultReviewBody,
      review: { ...resultReviewBody.review, verdict: "revise" },
    },
    {
      ...resultReviewBody,
      review: {
        ...resultReviewBody.review,
        revision: work.latestCompletionValidation!.revision,
      },
    },
    {
      ...resultReviewBody,
      review: {
        ...resultReviewBody.review,
        boundActionProgress: [{ actionKey: "different", status: "blocked" }],
      },
    },
    {
      ...resultReviewBody,
      boundResultSequence: 1,
      review: {
        ...resultReviewBody.review,
        boundResultRefs: [resultIds[0]],
      },
    },
  ]) {
    fixture.core.updateRecord(fixture.projectRoot, {
      id: resultReviewId,
      kind: "reference",
      body: resealProjectWorkChild(corruptResultReview),
    });
    fixture.core.writeIndex(fixture.projectRoot);
    const reviewEvents = ledgerText(fixture.projectRoot);
    await expect(service.loadContext(scope)).rejects.toThrow(
      "project_work_managed_record_invalid",
    );
    expect(ledgerText(fixture.projectRoot)).toBe(reviewEvents);
  }
  fixture.core.updateRecord(fixture.projectRoot, {
    id: resultReviewId,
    kind: "reference",
    body: stableJson(resultReviewBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const workRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "work",
    id: work.workId,
  });
  const workBody = JSON.parse(fixture.core.readRecordBody(workRecord.filePath)!);
  const incoherentView = {
    ...work,
    latestResultReview: work.latestPlanReview,
  };
  const incoherentFingerprint = dispositionMaterialFingerprint(incoherentView);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: work.workId,
    kind: "work",
    body: stableJson({
      ...workBody,
      latestResultReviewRevisionId: planReviewId,
      materialFingerprint: incoherentFingerprint,
      materialSnapshot: captureMaterialSnapshot(
        incoherentView,
        { effectWatermark: null, effectBlockers: [] },
        incoherentFingerprint,
      ),
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const pointerEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(pointerEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: work.workId,
    kind: "work",
    body: stableJson(workBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const coordinatedView = {
    ...work,
    currentStage: "validation" as const,
    allowedNextStages: allowedNextWorkStages("validation"),
    latestCheckpoint: {
      ...work.latestCheckpoint!,
      stage: "validation" as const,
    },
  };
  const coordinatedFingerprint = dispositionMaterialFingerprint(coordinatedView);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson({
      ...checkpointBody,
      checkpoint: { ...checkpointBody.checkpoint, stage: "validation" },
    }),
  });
  fixture.core.updateRecord(fixture.projectRoot, {
    id: work.workId,
    kind: "work",
    body: stableJson({
      ...workBody,
      currentStage: "validation",
      allowedNextStages: allowedNextWorkStages("validation"),
      materialFingerprint: coordinatedFingerprint,
      materialSnapshot: captureMaterialSnapshot(
        coordinatedView,
        { effectWatermark: null, effectBlockers: [] },
        coordinatedFingerprint,
      ),
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const coordinatedEvents = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(coordinatedEvents);
  fixture.core.updateRecord(fixture.projectRoot, {
    id: checkpointId,
    kind: "reference",
    body: stableJson(checkpointBody),
  });
  fixture.core.updateRecord(fixture.projectRoot, {
    id: work.workId,
    kind: "work",
    body: stableJson(workBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);

  const completionId = work.latestCompletionValidation!.reviewRevisionId;
  const completionRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: completionId,
  });
  const completionBody = JSON.parse(
    fixture.core.readRecordBody(completionRecord.filePath)!,
  );
  fixture.core.updateRecord(fixture.projectRoot, {
    id: completionId,
    kind: "reference",
    body: stableJson({
      ...completionBody,
      review: {
        ...completionBody.review,
        boundResultReviewRevisionId: work.latestPlanReview!.reviewRevisionId,
      },
    }),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  const events = ledgerText(fixture.projectRoot);
  await expect(service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  expect(ledgerText(fixture.projectRoot)).toBe(events);
});

test("strict snapshot permits a revised Result Review over an earlier exact sequence", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "revised-result-start",
    objective: "Revise an earlier result",
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "revised-result-plan",
    objective: "Revise an earlier result",
    actions: [{ actionKey: "one", description: "One", dependencyKeys: [] }],
    checks: ["exact"],
  });
  let work = await service.recordReview({
    ...scope,
    mutationCallId: "revised-result-plan-review",
    subject: "plan",
    verdict: "accept",
    summary: "Plan accepted",
    corrections: [],
  });
  await appendCanonicalResult(fixture, work, 1, "2026-08-25T00:00:02.000Z");
  work = await service.recordReview({
    ...scope,
    mutationCallId: "revised-result-review",
    subject: "result",
    verdict: "revise",
    correctionScope: "execution",
    summary: "Result needs revision",
    corrections: ["Try again"],
  });
  await appendCanonicalResult(fixture, work, 2, "2026-08-24T00:00:01.000Z");
  const loaded = await service.loadContext(scope);
  expect(loaded?.work.latestResultReview?.verdict).toBe("revise");
  expect(loaded?.work.latestResultReview?.boundResultRefs).toHaveLength(1);
  expect(loaded?.work.resultRefs).toHaveLength(2);
});

test("completion revise and partial remain strict-readable through correction work", async () => {
  for (const [verdict, correctionScope] of [
    ["revise", "planning"],
    ["partial", "execution"],
  ] as const) {
    const fixture = await createFixture();
    const service = createDurableWorkService(
      createProjectWorkStore(fixture.adapterInput),
    );
    const scope = fixture.scope("turn-1");
    await service.startWork({
      ...scope,
      mutationCallId: `completion-${verdict}-start`,
      objective: `Completion ${verdict}`,
    });
    await service.replacePlan({
      ...scope,
      mutationCallId: `completion-${verdict}-plan`,
      objective: `Completion ${verdict}`,
      actions: [{ actionKey: "one", description: "One", dependencyKeys: [] }],
      checks: ["exact"],
    });
    await service.recordReview({
      ...scope,
      mutationCallId: `completion-${verdict}-plan-review`,
      subject: "plan",
      verdict: "accept",
      summary: "Plan accepted",
      corrections: [],
    });
    await service.recordReview({
      ...scope,
      mutationCallId: `completion-${verdict}-result-review`,
      subject: "result",
      verdict: "accept",
      summary: "Result accepted",
      corrections: [],
    });
    const corrected = await service.recordReview({
      ...scope,
      mutationCallId: `completion-${verdict}-review`,
      subject: "completion",
      verdict,
      correctionScope,
      summary: "Correction required",
      corrections: ["Correct it"],
    });
    expect((await service.loadContext(scope))?.work).toEqual(corrected);
    if (correctionScope === "planning") {
      const replaced = await service.replacePlan({
        ...scope,
        mutationCallId: "completion-revise-correction-plan",
        objective: "Corrected Plan",
        actions: [
          { actionKey: "corrected", description: "Correct", dependencyKeys: [] },
        ],
        checks: ["corrected"],
      });
      expect(replaced.currentStage).toBe("planning");
    } else {
      const checkpoint = await service.recordCheckpoint({
        ...scope,
        mutationCallId: "completion-partial-correction-checkpoint",
        actionUpdates: [{ actionKey: "one", status: "done" }],
        publicSummary: "Corrected execution",
        nextStep: "Review again",
      });
      expect(checkpoint.currentStage).toBe("execution");
    }
  }
});

test("completion accepts action progress after an accepted result review", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "progress-start",
    objective: "Finish reviewed actions",
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "progress-plan",
    objective: "Finish reviewed actions",
    actions: [
      { actionKey: "implement", description: "Implement", dependencyKeys: [] },
      { actionKey: "review", description: "Review", dependencyKeys: ["implement"] },
    ],
    checks: ["completion is readable"],
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "progress-plan-review",
    subject: "plan",
    verdict: "accept",
    summary: "Plan accepted",
    corrections: [],
  });
  const resultReviewed = await service.recordReview({
    ...scope,
    mutationCallId: "progress-result-review",
    subject: "result",
    verdict: "accept",
    summary: "Implementation accepted",
    corrections: [],
    actionUpdates: [{ actionKey: "implement", status: "active" }],
  });
  expect(resultReviewed.actionProgress.map(({ status }) => status)).toEqual([
    "active",
    "pending",
  ]);

  const completed = await service.recordReview({
    ...scope,
    mutationCallId: "progress-completion-review",
    subject: "completion",
    verdict: "accept",
    summary: "Work complete",
    corrections: [],
    actionUpdates: [
      { actionKey: "implement", status: "done" },
      { actionKey: "review", status: "done" },
    ],
  });

  expect(completed.actionProgress.map(({ status }) => status)).toEqual([
    "done",
    "done",
  ]);
  expect((await service.loadContext(scope))?.work).toEqual(completed);
});

test("invalid Work candidates never replace the canonical Ledger", async () => {
  const fixture = await createFixture();
  const service = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const scope = fixture.scope("turn-1");
  await service.startWork({
    ...scope,
    mutationCallId: "candidate-start",
    objective: "Keep canonical Work readable",
  });
  await service.replacePlan({
    ...scope,
    mutationCallId: "candidate-plan",
    objective: "Keep canonical Work readable",
    actions: [{ actionKey: "finish", description: "Finish", dependencyKeys: [] }],
    checks: ["candidate is readable"],
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "candidate-plan-review",
    subject: "plan",
    verdict: "accept",
    summary: "Plan accepted",
    corrections: [],
  });
  await service.recordReview({
    ...scope,
    mutationCallId: "candidate-result-review",
    subject: "result",
    verdict: "accept",
    summary: "Result accepted",
    corrections: [],
  });
  const work = await service.recordReview({
    ...scope,
    mutationCallId: "candidate-completion-review",
    subject: "completion",
    verdict: "accept",
    summary: "Completion accepted",
    corrections: [],
    actionUpdates: [{ actionKey: "finish", status: "done" }],
  });
  const completionId = work.latestCompletionValidation!.reviewRevisionId;
  const completionRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference",
    id: completionId,
  });
  const completionBody = JSON.parse(
    fixture.core.readRecordBody(completionRecord.filePath)!,
  );
  const canonicalLedger = ledgerText(fixture.projectRoot);
  const identity = {
    kind: "mutation_call" as const,
    id: "invalid-candidate-publication",
    mutationCallId: "invalid-candidate-publication",
    requestSha256: createHash("sha256")
      .update("invalid-candidate-publication")
      .digest("hex"),
  };

  await expect(publishProjectWorkRecords({
    butlerData: fixture.butlerData,
    scope: fixture.adapterInput.scope,
    identity,
    prepareUpdates: () => Promise.resolve([{
      operation: "update",
      kind: "reference",
      id: completionId,
      parentId: work.workId,
      title: "Guided Work completion Review",
      status: "active",
      spec: "SPEC-BTCC-R3-WORK-LEDGER-SCOPE",
      body: resealProjectWorkChild({
        ...completionBody,
        review: {
          ...completionBody.review,
          boundActionProgress: [{ actionKey: "different", status: "done" }],
        },
      }),
    }]),
  })).rejects.toThrow();

  expect(ledgerText(fixture.projectRoot)).toBe(canonicalLedger);
  expect(fixture.core.readRecordBody(completionRecord.filePath)).toBe(
    stableJson(completionBody),
  );
});

async function createFixture(
  root = mkdtempSync(join(tmpdir(), "btcc-project-work-adapter-")),
  initialize = true,
) {
  if (!roots.includes(root)) roots.push(root);
  const butlerData = join(root, "butler-data");
  const requestedProjectRoot = join(
    butlerData,
    "project-ledger",
    "projects",
    "ledger-project",
  );
  mkdirSync(requestedProjectRoot, { recursive: true });
  const projectRoot = realpathSync(requestedProjectRoot);
  if (initialize) {
    writeFileSync(
      join(projectRoot, "project.json"),
      `${JSON.stringify(
        {
          schema: "project-ledger.project.v1",
          id: "ledger-project",
          name: "Fixture",
          status: "active",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(projectRoot, "ledger.jsonl"), "");
  }
  const core = await loadProjectLedgerCore();
  if (initialize) core.writeIndex(projectRoot);
  const runtime = new TestRuntimeProjection();
  runtime.originals.set("turn-1", {
    turnId: "turn-1",
    messageId: "message-turn-1",
    content: "start request",
  });
  const resultCalls: string[] = [];
  const adapterInput = {
    butlerData,
    scope: {
      appProjectId: "app-project",
      ledgerProjectId: "ledger-project",
      ledgerRoot: projectRoot,
    },
    runtimeProjection: runtime,
    resultRuntime: {
      readCommittedResult(input: { toolCallId: string; turnId: string }) {
        resultCalls.push(input.toolCallId);
        return {
          toolCallId: input.toolCallId,
          toolName: "read_file",
          status: "completed" as const,
          resultSha256: createHash("sha256").update(`result:${input.toolCallId}`).digest("hex"),
          originTurnId: input.turnId,
          sourceTurnRowid: 1,
          sourceTurnSequence: 1,
        };
      },
      observeCanonicalResult(input: { work: DurableWorkView }) {
        const binding =
          runtime.bindings.get("turn-2") ?? runtime.bindings.get("turn-1");
        if (!binding) throw new Error("missing test binding");
        if (input.work.workId !== binding.workId) throw new Error("wrong result Work");
      },
    },
  };
  return {
    butlerData,
    core,
    projectRoot,
    runtime,
    adapterInput,
    resultCalls,
    scope(turnId: string) {
      return { turnId, sessionId: "session-1", projectRef: "app-project" };
    },
  };
}

async function appendCanonicalResult(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  work: DurableWorkView,
  sequence: number,
  attachedAt: string,
): Promise<DurableWorkView> {
  const toolCallId = `window-tool-${sequence}`;
  const resultRef = projectWorkRecordId("result", toolCallId);
  const result = {
    resultRef,
    toolCallId,
    toolName: "read_file",
    status: "completed" as const,
    resultSha256: String(sequence).repeat(64),
    originTurnId: "turn-1",
    attachedAt,
  };
  const workRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "work",
    id: work.workId,
  });
  const manifest = JSON.parse(
    fixture.core.readRecordBody(workRecord.filePath)!,
  );
  const operationIdentity = {
    kind: "mutation_call" as const,
    id: toolCallId,
    mutationCallId: toolCallId,
    requestSha256: createHash("sha256")
      .update(stableJson({ toolCallId, sequence, attachedAt, workId: work.workId }))
      .digest("hex"),
  };
  const childBody = canonicalProjectWorkChildBody({
      schema: "butler.btcc-project-work-result-reference.v1",
      workId: work.workId,
      sessionId: work.sessionId,
      scope: {
        appProjectId: fixture.adapterInput.scope.appProjectId,
        ledgerProjectId: fixture.adapterInput.scope.ledgerProjectId,
      },
      operationIdentity,
      result: { ...result, sequence },
  });
  const updated = { ...work, resultRefs: [...work.resultRefs, result] };
  manifest.resultRefs = updated.resultRefs;
  manifest.resultSequence = updated.resultRefs.length;
  manifest.operationIdentity = operationIdentity;
  manifest.updatedAt = attachedAt;
  manifest.materialFingerprint = dispositionMaterialFingerprint(updated);
  manifest.materialSnapshot = captureMaterialSnapshot(
    updated,
    { effectWatermark: null, effectBlockers: [] },
    manifest.materialFingerprint,
  );
  await publishProjectWorkRecords({
    butlerData: fixture.butlerData,
    scope: fixture.adapterInput.scope,
    identity: operationIdentity,
    prepareUpdates: () => Promise.resolve([
      {
        operation: "create",
        kind: "reference",
        id: resultRef,
        parentId: work.workId,
        title: `Guided Work Result ${sequence}`,
        status: "active",
        spec: "SPEC-BTCC-R3-WORK-LEDGER-SCOPE",
        body: childBody,
      },
      {
        operation: "update",
        kind: "work",
        id: work.workId,
        title: `Guided Work ${work.workId}`,
        status: work.status === "completed" ? "review" : "in_progress",
        spec: "SPEC-BTCC-R3-WORK-LEDGER-SCOPE",
        body: stableJson(manifest),
      },
    ]),
  });
  return updated;
}

class TestRuntimeProjection implements ProjectWorkRuntimeProjection {
  currentViewNext = false;
  observationFailures = 0;
  observationError: Error | null = null;
  dispositionPreparations = 0;
  materialCaptures = 0;
  originalFailure: Error | null = null;
  materialFingerprintOverride: string | undefined;
  effectProof = {
    effectWatermark: null as string | null,
    effectBlockers: [] as Array<{
      blockerId: string;
      sourceTurnId: string;
      capabilitySha256: string;
      targetSha256: string;
      detailSha256: string;
    }>,
  };
  readonly observations: string[][] = [];
  readonly heads = new Map<string, string>();
  readonly bindings = new Map<string, { workId: string; sessionId: string }>();
  readonly works = new Map<string, DurableWorkView>();
  readonly originals = new Map<
    string,
    { turnId: string; messageId: string; content: string }
  >();
  locateCanonicalWorks(input: { sessionId?: string; turnId?: string }) {
    return Promise.resolve({
      sessionHeadWorkId: input.sessionId
        ? this.heads.get(input.sessionId) ?? null
        : null,
      bindingWorkId: input.turnId
        ? this.bindings.get(input.turnId)?.workId ?? null
        : null,
    });
  }
  loadOriginalRequest(scope: { turnId: string }) {
    if (this.originalFailure) throw this.originalFailure;
    const original = this.originals.get(scope.turnId);
    if (!original) throw new Error("missing original request");
    return Promise.resolve(original);
  }
  loadResultFacts() {
    return Promise.resolve([]);
  }
  operationRecordedAt(identity: ProjectWorkOperationIdentity) {
    const serial =
      [...identity.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
      1000;
    return Promise.resolve(
      new Date(Date.UTC(2026, 7, 25, 0, 0, serial)).toISOString(),
    );
  }
  prepareDisposition(input: {
    command: Parameters<
      ReturnType<typeof createDurableWorkService>["recordDisposition"]
    >[0];
    current: DurableWorkView;
  }) {
    this.dispositionPreparations += 1;
    if (this.currentViewNext) {
      this.currentViewNext = false;
      return Promise.resolve({ mode: "current_view" as const });
    }
    return Promise.resolve({
      mode: "apply" as const,
      actionProgress:
        (input.command.actionUpdates?.length ?? 0) > 0
          ? applyWorkActionUpdates(
              input.current,
              input.command.actionUpdates ?? [],
            )
          : input.current.actionProgress,
      evidenceSnapshot: input.command.evidenceRefs ?? [],
    });
  }
  captureWorkMaterial(input: { candidate: DurableWorkView }) {
    this.materialCaptures += 1;
    const materialFingerprint =
      this.materialFingerprintOverride ??
      dispositionMaterialFingerprint(input.candidate);
    return Promise.resolve({
      materialFingerprint,
      materialSnapshot: captureMaterialSnapshot(
        input.candidate,
        this.effectProof,
        materialFingerprint,
      ),
    });
  }
  observeCanonicalWorks(input: {
    works: Array<{
      work: DurableWorkView;
      bindings: Array<{ turnId: string; isCurrent: boolean }>;
    }>;
    sessionHeadWorkId: string;
  }) {
    if (this.observationError) throw this.observationError;
    if (this.observationFailures > 0) {
      this.observationFailures -= 1;
      throw new Error("test_projection_fault");
    }
    this.observations.push(input.works.map((item) => item.work.workId));
    for (const item of input.works) {
      this.works.set(item.work.workId, item.work);
      for (const { turnId } of item.bindings.filter((binding) => binding.isCurrent)) {
        this.bindings.set(turnId, {
          workId: item.work.workId,
          sessionId: item.work.sessionId,
        });
      }
    }
    const head = input.works.find(
      (item) => item.work.workId === input.sessionHeadWorkId,
    );
    if (head) this.heads.set(head.work.sessionId, input.sessionHeadWorkId);
    return Promise.resolve();
  }
}

function ledgerText(projectRoot: string): string {
  return readFileSync(join(projectRoot, "ledger.jsonl"), "utf8");
}

function occurrenceCount(butlerData: string): number {
  const directory = join(
    butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  );
  return existsSync(directory) ? readdirSync(directory).length : 0;
}

function occurrenceFor(butlerData: string, operationId: string) {
  const directory = join(
    butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  );
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const occurrence = JSON.parse(readFileSync(path, "utf8"));
    if (occurrence.operationIdentity.id === operationId)
      return { path, occurrence };
  }
  throw new Error("missing test occurrence");
}

function publicationReceiptPath(butlerData: string, publicationId: string) {
  return join(
    butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "receipts",
    `${publicationId}.json`,
  );
}

function resealOccurrence(occurrence: Record<string, any>): void {
  for (const attempt of occurrence.attempts) {
    attempt.publicationId = createHash("sha256")
      .update(
        JSON.stringify({
          schema: "butler.btcc-project-ledger-effect-publication.v2",
          occurrenceId: occurrence.occurrenceId,
          attemptNumber: attempt.number,
          requestSha256: attempt.requestSha256,
          expectedBase: attempt.expectedBase,
          targetPreconditions: attempt.targetPreconditions,
        }),
      )
      .digest("hex");
  }
}

function canonicalHeadIds(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): string[] {
  return fixture.core
    .buildIndex(fixture.projectRoot)
    .records.filter((record) => record.kind === "work")
    .filter((record) => {
      const body = fixture.core.readRecordBody(
        fixture.core.projectPath(fixture.projectRoot, record.path),
      );
      return body ? JSON.parse(body).sessionHead === true : false;
    })
    .map((record) => record.id);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resealProjectWorkChild(value: Record<string, unknown>): string {
  const { recordSha256: _oldProof, ...child } = value;
  return canonicalProjectWorkChildBody(
    child as Parameters<typeof canonicalProjectWorkChildBody>[0],
  );
}

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  applyProjectLedgerRecordUpdates,
  openBtccSqliteStores,
  readCanonicalProjectLedger,
} from "../../packages/butler-agent/src/agent/adapters/index.ts";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { createGuidedEffectService } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import type { GuidedEffectFaultHook } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import {
  createGuidedProjectLedgerEffectAdapter,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-project-ledger-effect.ts";
import {
  ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA,
  type ActiveProjectLedgerReference,
} from
  "../../packages/butler-agent/src/integrations/project-ledger/active-project-ledger-reference.ts";
import {
  createLegacyR2BtccDatabase,
  seedLegacyR2Turn,
  seedPendingLegacyOperation,
} from "./support/btcc-r2-legacy-turn-cutover-fixture.ts";
import { seedLegacySessionWork } from
  "./support/btcc-r3-legacy-session-work-fixture.ts";
import {
  clearProjectFixtures,
  projectFixture,
} from "./support/btcc-r3-project-ledger-fixture.ts";

const SESSION_ID = "session-fixture";
const SOURCE_TURN_ID = "turn-r2-project-ledger-effect";
const LEGACY_REQUEST_ID = "r2-project-ledger-update";
const LEGACY_EFFECT_KEY =
  "r2-ledger-intent:r2-ledger-intent-sha256:update-ledger-once";

afterEach(() => {
  clearProjectFixtures();
});

test("adopts an applied optional-kind R2 batch through the production R3 adapter without dispatch", async () => {
  const harness = await createHarness({
    recordId: "REPORT-LEGACY-SAME",
    currentKind: "report",
    legacyUpdate: {
      id: "REPORT-LEGACY-SAME",
      body: "Already applied by R2",
    },
    currentArgs: {
      kind: "report",
      id: "REPORT-LEGACY-SAME",
      body: "Already applied by R2",
    },
    applyLegacy: true,
  });
  try {
    expect(harness.stores.legacyCutover.blockers).toContainEqual({
      turnId: SOURCE_TURN_ID,
      kind: "pending_external_effect",
      referenceId: LEGACY_REQUEST_ID,
      detail: "A legacy external effect request has no committed result.",
      capability: "project_ledger_update",
      target: "project-ledger:*:REPORT-LEGACY-SAME",
    });
    const before = productMutationSnapshot(harness);

    expect(await harness.execute()).toMatchObject({
      ok: true,
      status: "applied",
      result: {
        effect: "project_ledger_publication",
        updated_records: [{ id: "REPORT-LEGACY-SAME" }],
      },
    });

    expect(productMutationSnapshot(harness)).toEqual(before);
    expect(await recordBody(harness, "report", "REPORT-LEGACY-SAME"))
      .toBe("Already applied by R2");
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
  } finally {
    harness.close();
  }
});

test("a typed R3 Project Ledger alias cannot bypass the legacy generic-update blocker", async () => {
  const harness = await createHarness({
    recordId: "W-LEGACY-ALIAS",
    currentKind: "work",
    currentToolName: "project_ledger_work_update",
    legacyUpdate: {
      id: "W-LEGACY-ALIAS",
      body: "Already applied through the R2 generic update",
    },
    currentArgs: {
      id: "W-LEGACY-ALIAS",
      body: "Already applied through the R2 generic update",
    },
    applyLegacy: true,
  });
  try {
    const before = productMutationSnapshot(harness);

    expect(await harness.execute()).toMatchObject({
      ok: true,
      status: "applied",
    });

    expect(productMutationSnapshot(harness)).toEqual(before);
    expect(await recordBody(harness, "work", "W-LEGACY-ALIAS"))
      .toBe("Already applied through the R2 generic update");
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
  } finally {
    harness.close();
  }
});

test("a current Project Ledger create is not aliased to the legacy update family", async () => {
  const project = await projectFixture();
  const create = createGuidedProjectLedgerEffectAdapter({
    name: "project_ledger_create",
    args: {
      kind: "report",
      id: "REPORT-CREATE-NOT-LEGACY-UPDATE",
      title: "New report",
    },
    butlerData: join(project.root, "data"),
    projectRoot: project.ledgerRoot,
    projectRef: "fixture-project",
    resolveActiveProjectReference: exactAppBinding(project.ledgerRoot),
  });

  expect(await create.adapter.classifyEffectBlocker?.({
    blockerCapability: "project_ledger_update",
    blockerTarget: "project-ledger:*:REPORT-CREATE-NOT-LEGACY-UPDATE",
    blockerInput: {
      updates: [{
        id: "REPORT-CREATE-NOT-LEGACY-UPDATE",
        title: "New report",
      }],
    },
    normalizedTarget: create.target,
    normalizedInput: create.normalizedInput,
  })).toBe("unrelated");
});

test("an applied two-record R2 batch keeps each target fenced across receipt crash and replay", async () => {
  const harness = await createHarness({
    recordId: "REPORT-LEGACY-BATCH-A",
    currentKind: "report",
    legacyUpdate: {
      id: "REPORT-LEGACY-BATCH-A",
      body: "Applied batch A",
    },
    legacyUpdates: [{
      id: "REPORT-LEGACY-BATCH-A",
      body: "Applied batch A",
    }, {
      id: "REPORT-LEGACY-BATCH-B",
      body: "Applied batch B",
    }],
    currentArgs: {
      kind: "report",
      id: "REPORT-LEGACY-BATCH-A",
      body: "Applied batch A",
    },
    additionalCurrentArgs: [{
      kind: "report",
      id: "REPORT-LEGACY-BATCH-B",
      body: "Applied batch B",
    }],
    beforeLegacyRecords: [{
      kind: "report",
      id: "REPORT-LEGACY-BATCH-B",
      title: "Legacy batch B",
      body: "Before B",
    }],
    applyLegacy: true,
  });
  try {
    const before = productMutationSnapshot(harness);
    let crashAfterReceipt = true;
    await expect(harness.executeAt(0, (point) => {
      if (crashAfterReceipt && point === "after_receipt") {
        crashAfterReceipt = false;
        throw new Error("synthetic crash after adopted batch A receipt");
      }
    })).rejects.toThrow("synthetic crash after adopted batch A receipt");
    expect(productMutationSnapshot(harness)).toEqual(before);
    expect(await harness.boundWork()).toMatchObject({ status: "open" });
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
    expect(harness.reconciliationEvidence()).toMatchObject([
      { status: "applied", resolution: { status: "applied" } },
      { status: "applied", resolution: { status: "applied" } },
    ]);

    expect(await harness.executeAt(0)).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
    });
    expect(await harness.boundWork()).toMatchObject({ status: "open" });
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
    expect(productMutationSnapshot(harness)).toEqual(before);

    expect(await harness.executeAt(1)).toMatchObject({
      ok: true,
      status: "applied",
    });
    expect(productMutationSnapshot(harness)).toEqual(before);
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
    expect(await recordBody(harness, "report", "REPORT-LEGACY-BATCH-A"))
      .toBe("Applied batch A");
    expect(await recordBody(harness, "report", "REPORT-LEGACY-BATCH-B"))
      .toBe("Applied batch B");
  } finally {
    harness.close();
  }
});

test("durable applied evidence blocks an equivalent retry but permits a different update when the old occurrence disappears", async () => {
  const harness = await createHarness({
    recordId: "REPORT-EVIDENCE-A",
    currentKind: "report",
    legacyUpdate: {
      id: "REPORT-EVIDENCE-A",
      body: "Applied evidence A",
    },
    legacyUpdates: [{
      id: "REPORT-EVIDENCE-A",
      body: "Applied evidence A",
    }, {
      id: "REPORT-EVIDENCE-B",
      body: "Applied evidence B",
    }],
    currentArgs: {
      kind: "report",
      id: "REPORT-EVIDENCE-A",
      body: "Applied evidence A",
    },
    additionalCurrentArgs: [{
      kind: "report",
      id: "REPORT-EVIDENCE-B",
      body: "New B after durable evidence",
    }],
    beforeLegacyRecords: [{
      kind: "report",
      id: "REPORT-EVIDENCE-B",
      title: "Evidence B",
      body: "Before B",
    }],
    applyLegacy: true,
  });
  try {
    const before = productMutationSnapshot(harness);
    await expect(harness.executeAt(0, (point) => {
      if (point === "after_blocker_resolution") {
        throw new Error("synthetic crash after durable legacy resolution");
      }
    })).rejects.toThrow("synthetic crash after durable legacy resolution");
    expect(productMutationSnapshot(harness)).toEqual(before);
    expect(await harness.boundWork()).toMatchObject({ status: "open" });
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();

    removeLegacyOccurrence(harness);
    const withoutLegacyOccurrence = productMutationSnapshot(harness);
    expect(withoutLegacyOccurrence).toEqual({
      ledgerEvents: before.ledgerEvents,
      occurrences: before.occurrences - 1,
    });
    expect(await harness.executeAt(0)).toMatchObject({
      ok: false,
      status: "uncertain",
      error: {
        code: "effect_reconciliation_required",
        message: expect.stringContaining("Durable legacy evidence"),
      },
    });
    expect(productMutationSnapshot(harness)).toEqual(withoutLegacyOccurrence);

    expect(await harness.executeAt(1)).toMatchObject({
      ok: true,
      status: "applied",
    });
    const afterDifferentUpdate = productMutationSnapshot(harness);
    expect(afterDifferentUpdate.ledgerEvents)
      .toBeGreaterThan(withoutLegacyOccurrence.ledgerEvents);
    expect(afterDifferentUpdate.occurrences)
      .toBe(withoutLegacyOccurrence.occurrences + 1);
    expect(await recordBody(harness, "report", "REPORT-EVIDENCE-A"))
      .toBe("Applied evidence A");
    expect(await recordBody(harness, "report", "REPORT-EVIDENCE-B"))
      .toBe("New B after durable evidence");
  } finally {
    harness.close();
  }
});

test("reconciles an applied R2 batch then dispatches a different R3 update to the same record", async () => {
  const harness = await createHarness({
    recordId: "REPORT-LEGACY-DIFFERENT",
    currentKind: "report",
    legacyUpdate: {
      id: "REPORT-LEGACY-DIFFERENT",
      body: "R2 content",
    },
    currentArgs: {
      kind: "report",
      id: "REPORT-LEGACY-DIFFERENT",
      body: "New R3 content",
    },
    applyLegacy: true,
  });
  try {
    const before = productMutationSnapshot(harness);

    expect(await harness.execute()).toMatchObject({
      ok: true,
      status: "applied",
      result: {
        updated_records: [{
          id: "REPORT-LEGACY-DIFFERENT",
          kind: "report",
        }],
      },
    });

    const after = productMutationSnapshot(harness);
    expect(after.ledgerEvents).toBeGreaterThan(before.ledgerEvents);
    expect(after.occurrences).toBe(before.occurrences + 1);
    expect(await recordBody(harness, "report", "REPORT-LEGACY-DIFFERENT"))
      .toBe("New R3 content");
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
  } finally {
    harness.close();
  }
});

test("keeps an applied missing-kind R2 batch uncertain when the record id has multiple kinds", async () => {
  const harness = await createHarness({
    recordId: "DUPLICATE-LEGACY-ID",
    currentKind: "report",
    legacyUpdate: {
      id: "DUPLICATE-LEGACY-ID",
      body: "Applied while the id was unique",
    },
    currentArgs: {
      kind: "report",
      id: "DUPLICATE-LEGACY-ID",
      body: "Applied while the id was unique",
    },
    applyLegacy: true,
    afterLegacyRecords: [{
      kind: "reference",
      id: "DUPLICATE-LEGACY-ID",
      title: "Later duplicate",
      body: "A second kind now shares the id",
    }],
  });
  try {
    const before = productMutationSnapshot(harness);

    expect(await harness.execute()).toMatchObject({
      ok: false,
      status: "uncertain",
      error: {
        code: "effect_reconciliation_required",
        message: expect.stringContaining("cannot be mapped uniquely"),
      },
    });

    expect(productMutationSnapshot(harness)).toEqual(before);
    expect(await harness.boundWork()).toMatchObject({ status: "open" });
    expect((await harness.boundWork())?.effectBlockers).toBeUndefined();
  } finally {
    harness.close();
  }
});

test("does not let an uncertain R2 occurrence dispatch a new R3 mutation", async () => {
  const harness = await createHarness({
    recordId: "REPORT-LEGACY-UNCERTAIN",
    currentKind: "report",
    legacyUpdate: {
      id: "REPORT-LEGACY-UNCERTAIN",
      body: "Uncertain R2 content",
    },
    currentArgs: {
      kind: "report",
      id: "REPORT-LEGACY-UNCERTAIN",
      body: "Uncertain R2 content",
    },
    prepareConflictingOccurrence: true,
  });
  try {
    const before = productMutationSnapshot(harness);

    expect(await harness.execute()).toMatchObject({
      ok: false,
      status: "uncertain",
      error: { code: "effect_reconciliation_required" },
    });

    expect(productMutationSnapshot(harness)).toEqual(before);
    expect(await recordBody(harness, "report", "REPORT-LEGACY-UNCERTAIN"))
      .toBe("Before");
    expect((await harness.boundWork())?.effectBlockers).toHaveLength(1);
  } finally {
    harness.close();
  }
});

test("an explicit R2 kind does not block the same id in a different Project Ledger kind", async () => {
  const harness = await createHarness({
    recordId: "SHARED-EXPLICIT-ID",
    currentKind: "reference",
    legacyUpdate: {
      id: "SHARED-EXPLICIT-ID",
      kind: "report",
      body: "Applied report content",
    },
    currentArgs: {
      kind: "reference",
      id: "SHARED-EXPLICIT-ID",
      body: "Updated reference content",
    },
    beforeLegacyRecords: [{
      kind: "reference",
      id: "SHARED-EXPLICIT-ID",
      title: "Same id reference",
      body: "Before reference",
    }],
    applyLegacy: true,
  });
  try {
    const before = productMutationSnapshot(harness);

    expect(await harness.execute()).toMatchObject({
      ok: true,
      status: "applied",
    });

    const after = productMutationSnapshot(harness);
    expect(after.ledgerEvents).toBeGreaterThan(before.ledgerEvents);
    expect(after.occurrences).toBe(before.occurrences + 1);
    expect(await recordBody(harness, "report", "SHARED-EXPLICIT-ID"))
      .toBe("Applied report content");
    expect(await recordBody(harness, "reference", "SHARED-EXPLICIT-ID"))
      .toBe("Updated reference content");
  } finally {
    harness.close();
  }
});

type ProjectRecord = {
  kind: string;
  id: string;
  title: string;
  body: string;
};

type HarnessInput = {
  recordId: string;
  currentKind: string;
  legacyUpdate: Record<string, unknown>;
  legacyUpdates?: Record<string, unknown>[];
  currentArgs: Record<string, unknown>;
  currentToolName?: string;
  additionalCurrentArgs?: Record<string, unknown>[];
  additionalCurrentToolNames?: string[];
  beforeLegacyRecords?: ProjectRecord[];
  afterLegacyRecords?: ProjectRecord[];
  applyLegacy?: boolean;
  prepareConflictingOccurrence?: boolean;
};

async function createHarness(input: HarnessInput) {
  const project = await projectFixture();
  const butlerData = join(project.root, "data");
  const dbPath = join(project.root, "btcc.sqlite");
  if (input.currentKind === "work") {
    project.core.createWork(project.ledgerRoot, {
      id: input.recordId,
      title: "Legacy target Work",
      spec: "SPEC-LEGACY-TARGET",
      acceptance: "The legacy target is updated safely.",
      body: "Before",
    });
  } else {
    project.core.createRecord(project.ledgerRoot, {
      kind: "report",
      id: input.recordId,
      title: "Legacy target report",
      status: "active",
      body: "Before",
    });
  }
  for (const record of input.beforeLegacyRecords ?? []) {
    project.core.createRecord(project.ledgerRoot, record);
  }
  const legacyUpdates = input.legacyUpdates ?? [input.legacyUpdate];
  if (input.applyLegacy) {
    await applyProjectLedgerRecordUpdates({
      butlerData,
      projectRoot: project.ledgerRoot,
      effectKey: LEGACY_EFFECT_KEY,
      updates: legacyUpdates as Array<{
        id: string;
        kind?: string;
        body?: string;
      }>,
    });
  }
  for (const record of input.afterLegacyRecords ?? []) {
    project.core.createRecord(project.ledgerRoot, record);
  }
  if (input.prepareConflictingOccurrence) {
    writeConflictingOccurrence({
      butlerData,
      projectRoot: project.ledgerRoot,
      effectKey: LEGACY_EFFECT_KEY,
    });
  }

  const legacy = createLegacyR2BtccDatabase(dbPath);
  seedLegacySessionWork(legacy);
  seedLegacyR2Turn(legacy, {
    turnId: SOURCE_TURN_ID,
    sessionId: SESSION_ID,
    semanticState: "task_execution",
    originalMessage: "Continue the interrupted Project Ledger update",
  });
  legacy.query(`
    UPDATE btcc_turns SET managed_state_json = ?
    WHERE turn_id = ?
  `).run(JSON.stringify({ programId: "program-session" }), SOURCE_TURN_ID);
  seedPendingLegacyOperation(legacy, {
    turnId: SOURCE_TURN_ID,
    requestId: LEGACY_REQUEST_ID,
    kind: "external_effect",
    capabilityRef: "project_ledger_update",
    targetScopeRef: "ledger:fixture-project",
    occurrenceKey: "update-ledger-once",
    effectIntentRef: {
      id: "r2-ledger-intent",
      sha256: "r2-ledger-intent-sha256",
    },
    payload: { updates: legacyUpdates },
  });
  legacy.close();

  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: `legacy-project-effect-${input.recordId}-${input.currentKind}`,
    storageProfile: "ephemeral",
  });
  const command = freshRunCommand(project.root, input.recordId);
  const inbox = await stores.admission.recordInbound({
    command,
    admissionInputHash: `admission-${input.recordId}-${input.currentKind}`,
  });
  const claim = await stores.admission.acquireAdmissionConstructionClaim(inbox);
  await stores.admission.constructTurn(inbox, claim);
  const scope = { turnId: command.turnId, sessionId: SESSION_ID };
  const imported = await stores.durableWork.importOpenLegacyWork(scope);
  if (imported?.work.currentStage === "execution") {
    await stores.durableWork.bindOpenWork(scope, imported.work.workId);
    await stores.durableWork.recordCheckpoint({
      ...scope,
      mutationCallId: `review-imported-plan-${input.recordId}-${input.currentKind}`,
      nextStage: "review",
    });
  }
  const effectCalls = [{
    name: input.currentToolName ?? "project_ledger_update",
    args: input.currentArgs,
  }, ...(input.additionalCurrentArgs ?? []).map((args, index) => ({
    name: input.additionalCurrentToolNames?.[index] ??
      "project_ledger_update",
    args,
  }))];
  const effects = effectCalls.map(({ name, args }) =>
    createGuidedProjectLedgerEffectAdapter({
      name,
      args,
      butlerData,
      projectRoot: project.ledgerRoot,
      projectRef: "fixture-project",
      resolveActiveProjectReference: exactAppBinding(project.ledgerRoot),
    }));
  await stores.durableWork.replacePlan({
    ...scope,
    mutationCallId: `plan-${input.recordId}-${input.currentKind}`,
    objective: "Finish the interrupted Project Ledger update safely",
    actions: effects.map((effect, index) => ({
      actionKey: `update-ledger-record-${index + 1}`,
      description: "Apply the intended Project Ledger record update",
      dependencyKeys: [],
      effect: {
        capability: effect.adapter.capability,
        target: effect.target,
      },
    })),
    checks: ["The intended record has the requested content."],
  });
  const reviewed = await stores.durableWork.recordReview({
    ...scope,
    mutationCallId: `review-${input.recordId}-${input.currentKind}`,
    subject: "plan",
    verdict: "accept",
    summary: "The exact persistent target is approved.",
    corrections: [],
  });
  const executeAt = (
    index: number,
    faultHook?: GuidedEffectFaultHook,
  ) => {
    const effect = effects[index];
    if (!effect) throw new Error(`Missing test effect ${index}`);
    return createGuidedEffectService(
      stores.guidedEffectJournal,
      faultHook ? { faultHook } : {},
    ).execute({
      work: reviewed,
      accessMode: "full_access",
      signal: new AbortController().signal,
      occurrenceId: `fixture-effect-call-${index}`,
      target: effect.target,
      input: effect.normalizedInput,
      adapter: effect.adapter,
    });
  };
  return {
    project,
    butlerData,
    stores,
    execute: () => executeAt(0),
    executeAt,
    boundWork: () =>
      stores.durableWork.boundWorkForTurn(command.turnId) as
        Promise<DurableWorkView | null>,
    reconciliationEvidence: () =>
      stores.guidedEffectJournal.listEffectBlockersForReconciliation(
        reviewed.workId,
      ),
    close: () => stores.close(),
  };
}

function freshRunCommand(
  root: string,
  recordId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  const turnId = `turn-r3-${recordId}`;
  return {
    kind: "run",
    turnId,
    sessionId: SESSION_ID,
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "Continue the interrupted Project Ledger update",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "fresh-controls",
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

function productMutationSnapshot(
  harness: Awaited<ReturnType<typeof createHarness>>,
): { ledgerEvents: number; occurrences: number } {
  return {
    ledgerEvents: readFileSync(
      join(harness.project.ledgerRoot, "ledger.jsonl"),
      "utf8",
    ).split("\n").filter(Boolean).length,
    occurrences: occurrencePaths(harness.butlerData).length,
  };
}

async function recordBody(
  harness: Awaited<ReturnType<typeof createHarness>>,
  kind: string,
  id: string,
): Promise<string | null> {
  const ledger = await readCanonicalProjectLedger(harness.project.ledgerRoot);
  return ledger.records.find((record) => record.kind === kind && record.id === id)
    ?.body ?? null;
}

function occurrencePaths(butlerData: string): string[] {
  const root = join(
    butlerData,
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
  );
  try {
    return readdirSync(root).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

function removeLegacyOccurrence(
  harness: Awaited<ReturnType<typeof createHarness>>,
): void {
  const occurrenceId = sha256(stableJson({
    schema: "butler.btcc-project-ledger-effect.v1",
    projectRoot: harness.project.ledgerRoot,
    effectKey: LEGACY_EFFECT_KEY,
  }));
  rmSync(join(
    harness.butlerData,
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
    `${occurrenceId}.json`,
  ));
}

function writeConflictingOccurrence(input: {
  butlerData: string;
  projectRoot: string;
  effectKey: string;
}): void {
  const occurrenceId = sha256(stableJson({
    schema: "butler.btcc-project-ledger-effect.v1",
    projectRoot: input.projectRoot,
    effectKey: input.effectKey,
  }));
  const path = join(
    input.butlerData,
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
    `${occurrenceId}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: "butler.btcc-project-ledger-effect-occurrence.v1",
    effectKey: input.effectKey,
    updatesSha256: sha256(stableJson([{ id: "DIFFERENT-CONTENT" }])),
    publicationId: "conflicting-publication",
    status: "pending",
  }, null, 2)}\n`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactAppBinding(
  projectRoot: string,
): () => ActiveProjectLedgerReference {
  return () => ({
    schema_version: ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA,
    app_project_id: "fixture-project",
    workspace_path: projectRoot,
    ledger_project_id: "legacy-fixture-alias",
    ledger_root: projectRoot,
    source: "workspace_metadata",
    resolved_at: "2026-07-31T00:00:00.000Z",
    initialized: true,
    initialization_generation: "test",
  });
}

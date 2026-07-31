import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyProjectLedgerRecordUpdates,
  ProjectLedgerEffectConflictError,
  reconcileProjectLedgerRecordUpdates,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-mutation.ts";
import { loadProjectLedgerCore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import {
  createGuidedProjectLedgerEffectAdapter,
  guidedProjectLedgerEffect,
} from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-project-ledger-effect.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("R3 guided Project Ledger effect", () => {
  test("publishes typed create and update effects through the atomic Project Ledger path", async () => {
    const fixture = await projectLedgerFixture();
    const create = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_create",
      args: {
        kind: "report",
        id: "REPORT-R3",
        title: "R3 report",
        status: "active",
        body: "Before",
      },
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      projectRef: "fixture",
    });
    expect(create).toMatchObject({
      target: "project-ledger:report:REPORT-R3",
      normalizedInput: {
        operation: "create",
        id: "REPORT-R3",
        kind: "report",
      },
      adapter: { capability: "project_ledger_create" },
    });

    const created = await create.adapter.dispatch(effectDispatch("create-report"));
    expect(created).toMatchObject({
      status: "applied",
      result: {
        ok: true,
        effect: "project_ledger_publication",
        publication_id: expect.any(String),
        updated_records: [{ id: "REPORT-R3", kind: "report" }],
      },
    });
    const createdRecord = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "report",
      id: "REPORT-R3",
    });
    expect(fixture.core.readRecordBody(createdRecord.filePath)).toBe("Before");

    const update = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_update",
      args: {
        kind: "report",
        id: "REPORT-R3",
        title: "Updated R3 report",
        body: "After",
        reason: "Reviewed update",
      },
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      projectRef: "fixture",
    });
    expect(update).toMatchObject({
      target: "project-ledger:report:REPORT-R3",
      adapter: { capability: "project_ledger_update" },
    });
    const updated = await update.adapter.dispatch(effectDispatch("update-report"));
    expect(updated).toMatchObject({
      status: "applied",
      result: {
        publication_id: expect.any(String),
        updated_records: [{ id: "REPORT-R3", kind: "report" }],
      },
    });
    expect(fixture.core.readRecordBody(createdRecord.filePath)).toBe("After");
    expect(fixture.core.readRecordData(createdRecord.filePath)).toMatchObject({
      title: "Updated R3 report",
      reason: "Reviewed update",
    });
    expect(observedOccurrences(fixture.butlerData)).toHaveLength(2);
  });

  test("preserves hierarchical create fields and applies lifecycle tools", async () => {
    const fixture = await projectLedgerFixture();
    await dispatchProjectLedgerEffect(fixture, "create-work", "project_ledger_create", {
      kind: "work",
      id: "W-R3",
      title: "R3 work",
      status: "proposed",
      spec: "SPEC-R3",
      acceptance: "The requested result is delivered",
    });
    await dispatchProjectLedgerEffect(fixture, "create-task", "project_ledger_create", {
      kind: "task",
      id: "T-R3",
      title: "R3 task",
      work_id: "W-R3",
      acceptance: "The task result is reviewed",
    });
    await dispatchProjectLedgerEffect(fixture, "create-attempt", "project_ledger_create", {
      kind: "attempt",
      id: "A-R3",
      title: "R3 attempt",
      task_id: "T-R3",
    });

    const task = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "task",
      id: "T-R3",
    });
    expect(fixture.core.readRecordData(task.filePath)?.acceptance)
      .toBe("The task result is reviewed");
    await dispatchProjectLedgerEffect(
      fixture,
      "complete-task",
      "project_ledger_task_complete",
      {
        id: "T-R3",
        validation: "Task tests passed",
        review: "Task result accepted",
        report: "reports/task.md",
      },
    );
    await dispatchProjectLedgerEffect(
      fixture,
      "succeed-attempt",
      "project_ledger_attempt_succeed",
      {
        id: "A-R3",
        validation: "Attempt validated",
      },
    );
    await dispatchProjectLedgerEffect(
      fixture,
      "complete-work",
      "project_ledger_work_complete",
      {
        id: "W-R3",
        validation: "Work validation passed",
        review: "Work review accepted",
        report: "reports/work.md",
      },
    );

    expect(fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "task",
      id: "T-R3",
    }).record.status).toBe("done");
    expect(fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "attempt",
      id: "A-R3",
    }).record.status).toBe("succeeded");
    expect(fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "work",
      id: "W-R3",
    }).record.status).toBe("done");
    expect(observedOccurrences(fixture.butlerData)).toHaveLength(6);
  });

  test("replays the same effect key and input without another Ledger mutation", async () => {
    const fixture = await projectLedgerFixture();
    const input = {
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      effectKey: "same-effect",
      updates: [{
        operation: "create" as const,
        kind: "report",
        id: "REPORT-ONCE",
        title: "Exactly once",
        body: "One publication",
      }],
    };

    const first = await applyProjectLedgerRecordUpdates(input);
    const firstHead = fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot);
    const firstEvents = ledgerEvents(fixture.projectRoot);
    const replay = await applyProjectLedgerRecordUpdates(input);
    const replayHead = fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot);

    expect(replay).toEqual(first);
    expect(replayHead).toEqual(firstHead);
    expect(ledgerEvents(fixture.projectRoot)).toEqual(firstEvents);
    expect(fixture.core.buildIndex(fixture.projectRoot).records.filter(
      (record) => record.id === "REPORT-ONCE",
    )).toHaveLength(1);
  });

  test("rejects different input for an existing effect key as an occurrence conflict", async () => {
    const fixture = await projectLedgerFixture();
    const base = {
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      effectKey: "conflicting-effect",
    };
    await applyProjectLedgerRecordUpdates({
      ...base,
      updates: [{
        operation: "create",
        kind: "report",
        id: "REPORT-CONFLICT",
        title: "Original",
      }],
    });
    const before = fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot);

    await expect(applyProjectLedgerRecordUpdates({
      ...base,
      updates: [{
        operation: "update",
        kind: "report",
        id: "REPORT-CONFLICT",
        title: "Different",
      }],
    })).rejects.toBeInstanceOf(ProjectLedgerEffectConflictError);
    expect(fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot)).toEqual(before);
    const record = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "report",
      id: "REPORT-CONFLICT",
    });
    expect(fixture.core.readRecordData(record.filePath)?.title).toBe("Original");
  });

  test("returns an observed occurrence without repeating the mutation", async () => {
    const fixture = await projectLedgerFixture();
    const input = {
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      effectKey: "reconcile-effect",
      updates: [{
        operation: "create" as const,
        kind: "report",
        id: "REPORT-RECONCILE",
        title: "Reconciled",
      }],
    };
    const applied = await applyProjectLedgerRecordUpdates(input);
    const events = ledgerEvents(fixture.projectRoot);

    expect(await reconcileProjectLedgerRecordUpdates(input)).toEqual({
      status: "applied",
      result: applied,
    });
    expect(ledgerEvents(fixture.projectRoot)).toEqual(events);
    expect(JSON.parse(
      readFileSync(onlyOccurrencePath(fixture.butlerData), "utf8"),
    )).toMatchObject({
      status: "observed",
      result: { publicationId: applied.publicationId },
    });
  });

  test("finishes a prepared pending publication during reconciliation", async () => {
    const fixture = await projectLedgerFixture();
    const input = {
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      effectKey: "pending-effect",
      updates: [{
        operation: "create" as const,
        kind: "report",
        id: "REPORT-PENDING",
        title: "Pending publication",
        body: "Prepared but not promoted",
      }],
    };
    const before = fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot);
    preparePendingOccurrence(fixture, input);
    expect(fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot)).toEqual(before);
    expect(() => fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "report",
      id: "REPORT-PENDING",
    })).toThrow("record not found");

    const reconciled = await reconcileProjectLedgerRecordUpdates(input);
    expect(reconciled).toMatchObject({
      status: "applied",
      result: {
        effectKey: input.effectKey,
        updatedRecords: [{ id: "REPORT-PENDING", kind: "report" }],
      },
    });
    expect(fixture.core.readRecordBody(fixture.core.resolveRecord(
      fixture.projectRoot,
      { kind: "report", id: "REPORT-PENDING" },
    ).filePath)).toBe("Prepared but not promoted");
    expect(JSON.parse(
      readFileSync(onlyOccurrencePath(fixture.butlerData), "utf8"),
    )).toMatchObject({
      status: "observed",
      result: { effectKey: input.effectKey },
    });
  });

  test("leaves the canonical root unchanged when candidate materialization is invalid", async () => {
    const fixture = await projectLedgerFixture();
    const before = fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot);
    const projectBefore = readFileSync(join(fixture.projectRoot, "project.json"), "utf8");
    const ledgerBefore = readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8");

    await expect(applyProjectLedgerRecordUpdates({
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      effectKey: "invalid-prepared-effect",
      updates: [{
        operation: "update",
        kind: "report",
        id: "MISSING-REPORT",
        body: "Must never reach the canonical root",
      }],
    })).rejects.toThrow("record not found");

    expect(fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot)).toEqual(before);
    expect(readFileSync(join(fixture.projectRoot, "project.json"), "utf8"))
      .toBe(projectBefore);
    expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBefore);
    expect(observedOccurrences(fixture.butlerData)).toHaveLength(0);
  });

  test("requires a concrete kind for the exact generic-update target", () => {
    expect(() => guidedProjectLedgerEffect("project_ledger_update", {
      id: "REPORT-UNKNOWN-KIND",
      body: "Ambiguous target",
    })).toThrow("requires kind");
    expect(() => createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_update",
      args: {
        project_ref: "other-project",
        kind: "report",
        id: "REPORT-OTHER",
        body: "Wrong project",
      },
      butlerData: "/tmp/unused",
      projectRoot: "/tmp/unused-project",
      projectRef: "fixture",
    })).toThrow("differs from the active project");
  });
});

function effectDispatch(idempotencyKey: string) {
  return {
    normalizedTarget: "ignored-by-the-adapter",
    normalizedInput: {},
    idempotencyKey,
    signal: new AbortController().signal,
  };
}

async function dispatchProjectLedgerEffect(
  fixture: Awaited<ReturnType<typeof projectLedgerFixture>>,
  effectKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const effect = createGuidedProjectLedgerEffectAdapter({
    name,
    args,
    butlerData: fixture.butlerData,
    projectRoot: fixture.projectRoot,
    projectRef: "fixture",
  });
  expect(await effect.adapter.dispatch(effectDispatch(effectKey))).toMatchObject({
    status: "applied",
  });
}

async function projectLedgerFixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-project-ledger-effect-"));
  roots.push(root);
  const butlerData = join(root, "butler-data");
  const projectRoot = join(root, "contained-project-ledger");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "fixture",
    name: "Fixture",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(projectRoot, "ledger.jsonl"), "");
  const core = await loadProjectLedgerCore();
  return { root, butlerData, projectRoot, core };
}

function ledgerEvents(projectRoot: string): string[] {
  return readFileSync(join(projectRoot, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
}

function occurrencePaths(butlerData: string): string[] {
  const root = join(
    butlerData,
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
  );
  try {
    return readdirSync(root).filter((name) => name.endsWith(".json"))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

function observedOccurrences(butlerData: string): Array<Record<string, unknown>> {
  return occurrencePaths(butlerData).map((path) =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
  ).filter((occurrence) => occurrence.status === "observed");
}

function onlyOccurrencePath(butlerData: string): string {
  const paths = occurrencePaths(butlerData);
  if (paths.length !== 1) {
    throw new Error(
      `Expected one Project Ledger occurrence, found ${paths.length}`,
    );
  }
  return paths[0]!;
}

function preparePendingOccurrence(
  fixture: Awaited<ReturnType<typeof projectLedgerFixture>>,
  input: {
    butlerData: string;
    projectRoot: string;
    effectKey: string;
    updates: Array<{
      operation: "create";
      kind: string;
      id: string;
      title: string;
      body: string;
    }>;
  },
): void {
  const updatesSha256 = sha256(stableJson(input.updates));
  const occurrenceId = sha256(stableJson({
    schema: "butler.btcc-project-ledger-effect.v1",
    projectRoot: input.projectRoot,
    effectKey: input.effectKey,
  }));
  const publicationId = sha256(stableJson({
    schema: "butler.btcc-project-ledger-effect-publication.v1",
    occurrenceId,
    updatesSha256,
  }));
  const root = join(
    input.butlerData,
    "runtime",
    "btcc-project-ledger-effects",
  );
  const occurrencePath = join(root, "occurrences", `${occurrenceId}.json`);
  const candidateRoot = join(root, "candidates", publicationId);
  const journalPath = join(root, "journals", `${publicationId}.json`);
  fixture.core.prepareProjectLedgerPublication({
    publicationId,
    canonicalRoot: input.projectRoot,
    candidateRoot,
    journalPath,
    expectedBase: fixture.core.observeProjectLedgerSourceHead(input.projectRoot),
    materialize(projectRoot: string) {
      const [update] = input.updates;
      fixture.core.createRecord(projectRoot, {
        project: projectRoot,
        ...update,
      });
      for (const view of ["dashboard", "handoff", "roadmap"]) {
        fixture.core.render(projectRoot, view, { write: true });
      }
      const check = fixture.core.check(projectRoot);
      if (!check.ok) throw new Error("Prepared test publication is invalid");
    },
  });
  mkdirSync(dirname(occurrencePath), { recursive: true });
  writeFileSync(occurrencePath, `${JSON.stringify({
    schema: "butler.btcc-project-ledger-effect-occurrence.v1",
    effectKey: input.effectKey,
    updatesSha256,
    publicationId,
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

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-project-ledger-effect.ts";
import { createGuidedPersistentEffectResolver } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-persistent-effect-resolution.ts";
import type { GuidedPersistentEffectContext } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-execution-boundary.ts";
import {
  ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA,
  ActiveProjectLedgerResolver,
  type ActiveProjectLedgerReference,
} from
  "../../packages/butler-agent/src/integrations/project-ledger/active-project-ledger-reference.ts";

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
      resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
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
    expect(create.adapter.reviewedPlanBinding).toBe("accepted_plan");

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
      resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
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

  test("reviewed guided Project Ledger work update emits phase attribution without raw effect data", async () => {
    const fixture = await projectLedgerFixture();
    fixture.core.createWork(fixture.projectRoot, {
      project: fixture.projectRoot,
      id: "W-ATTRIBUTION",
      title: "Attribution work",
      status: "in_progress",
      acceptance: "The reviewed update is published",
    });
    const phases: Array<{ phase: string; status: string }> = [];
    const attribution = {
      checkpoint() {},
      projectLedgerPhase(input: { phase: string; status: string }) {
        phases.push({ phase: input.phase, status: input.status });
      },
      terminal() {},
      close() {},
    };
    const update = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_work_update",
      args: {
        id: "W-ATTRIBUTION",
        status: "review",
        body: "Private reviewed body must never enter diagnostics",
      },
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      projectRef: "fixture",
      resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
      memoryAttribution: attribution,
    });

    expect(await update.adapter.dispatch(effectDispatch("attribution-work-update")))
      .toMatchObject({ status: "applied" });
    expect(phases.map(({ phase, status }) => `${phase}:${status}`)).toEqual(expect.arrayContaining([
      "work_update:start",
      "observe_base:start",
      "prepare:start",
      "materialize:start",
      "render_dashboard:start",
      "render_handoff:start",
      "render_roadmap:start",
      "write_index:start",
      "promote:start",
      "observe_promotion:start",
      "observe_current_head:start",
      "work_update:end",
    ]));
    expect(JSON.stringify(phases)).not.toContain("Private reviewed body");
  });

  test("initializes the Ledger only when the reviewed adapter execution begins", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-project-ledger-init-"));
    roots.push(root);
    const butlerData = join(root, "butler-data");
    const projectRoot = join(root, "project-ledger", "projects", "fixture");
    let ensureCalls = 0;
    const effect = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_create",
      args: {
        kind: "work",
        id: "W-R3-INIT",
        title: "Initialize during reviewed effect",
        status: "proposed",
        spec: "SPEC-R3-INIT",
        acceptance: "The Ledger is initialized and the Work is recorded",
      },
      butlerData,
      projectRoot,
      projectRef: "fixture",
      resolveActiveProjectReference: exactAppBinding(projectRoot),
      initializeForCreate() {
        ensureCalls += 1;
        mkdirSync(projectRoot, { recursive: true });
        if (!existsSync(join(projectRoot, "project.json"))) {
          writeFileSync(join(projectRoot, "project.json"), `${JSON.stringify({
            schema: "project-ledger.project.v1",
            id: "fixture",
            name: "Fixture",
            status: "active",
          }, null, 2)}\n`);
          writeFileSync(join(projectRoot, "ledger.jsonl"), "");
        }
      },
    });

    expect(ensureCalls).toBe(0);
    expect(existsSync(projectRoot)).toBe(false);

    expect(await effect.adapter.reconcile({
      ...effectDispatch("init-work"),
      dispatchAttempts: 0,
    })).toEqual({ status: "not_applied" });
    expect(ensureCalls).toBe(0);
    expect(existsSync(projectRoot)).toBe(false);

    expect(await effect.adapter.dispatch(effectDispatch("init-work"))).toMatchObject({
      status: "applied",
      result: {
        updated_records: [{ id: "W-R3-INIT", kind: "work" }],
      },
    });
    expect(ensureCalls).toBe(1);

    expect(await effect.adapter.reconcile({
      ...effectDispatch("init-work"),
      dispatchAttempts: 1,
    })).toMatchObject({ status: "applied" });
    expect(ensureCalls).toBe(1);
    const core = await loadProjectLedgerCore();
    expect(core.buildIndex(projectRoot).records.filter(
      (record) => record.id === "W-R3-INIT",
    )).toHaveLength(1);
  });

  test("publishes useful Work when Project Ledger reports only advisory warnings", async () => {
    const fixture = await projectLedgerFixture();
    fixture.core.createWork(fixture.projectRoot, {
      project: fixture.projectRoot,
      id: "W-EXISTING-WARNING",
      title: "Existing warning",
      status: "in_progress",
      acceptance: "This deliberately exercises warning-only publication",
    });
    const effect = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_create",
      args: {
        kind: "report",
        id: "REPORT-WITH-WARNING",
        title: "Published while a warning exists",
      },
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      projectRef: "fixture",
      resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
    });

    expect(await effect.adapter.dispatch(effectDispatch("warning-only-work")))
      .toMatchObject({
        status: "applied",
        result: {
          updated_records: [{ id: "REPORT-WITH-WARNING", kind: "report" }],
        },
      });
    const check = fixture.core.check(fixture.projectRoot);
    expect(check.ok).toBe(false);
    expect(check.issues).toContainEqual(expect.objectContaining({
      code: "missing_spec",
      severity: "warning",
    }));
  });

  test("preserves acceptance arrays while creating and completing concise guided Work", async () => {
    const fixture = await projectLedgerFixture();
    await dispatchProjectLedgerEffect(
      fixture,
      "create-concise-work",
      "project_ledger_create",
      {
        kind: "work",
        id: "W-R3-CONCISE",
        title: "Concise guided work",
        status: "in_progress",
        acceptance: [
          "The requested result is delivered",
          "The requested result is validated",
        ],
      },
    );

    const created = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "work",
      id: "W-R3-CONCISE",
    });
    expect(created.record.status).toBe("in_progress");
    expect(created.record.specExemption).toBe(true);
    expect(fixture.core.readRecordData(created.filePath)?.acceptance).toBe(
      "The requested result is delivered\nThe requested result is validated",
    );

    await dispatchProjectLedgerEffect(
      fixture,
      "complete-concise-work",
      "project_ledger_work_complete",
      {
        id: "W-R3-CONCISE",
        validation: "The requested output passed its checks",
        review: "The result satisfies the request",
        report: "Delivered in the final response",
      },
    );

    const work = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "work",
      id: "W-R3-CONCISE",
    });
    expect(fixture.core.readRecordData(work.filePath)).toMatchObject({
      status: "done",
      specExemption: true,
    });
    expect(fixture.core.check(fixture.projectRoot).issues).not.toContainEqual(
      expect.objectContaining({ code: "missing_spec" }),
    );
  });

  test("completes an existing concise Work without losing effect identity", async () => {
    const fixture = await projectLedgerFixture();
    fixture.core.createWork(fixture.projectRoot, {
      project: fixture.projectRoot,
      id: "W-R3-EXISTING-CONCISE",
      title: "Existing concise work",
      status: "in_progress",
      acceptance: "The resumed request is validated and reported",
    });
    const effect = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_work_complete",
      args: {
        id: "W-R3-EXISTING-CONCISE",
        validation: "The resumed result passed its checks",
        review: "The result satisfies the original request",
        report: "The completed result was delivered",
      },
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      projectRef: "fixture",
      resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
    });

    expect(effect.normalizedInput).toMatchObject({
      id: "W-R3-EXISTING-CONCISE",
      status: "done",
      specExemption: true,
    });
    expect(await effect.adapter.dispatch(effectDispatch("complete-existing-concise")))
      .toMatchObject({ status: "applied" });
    const completed = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "work",
      id: "W-R3-EXISTING-CONCISE",
    });
    expect(completed.record).toMatchObject({
      status: "done",
      specExemption: true,
    });
  });

  test("normalizes Sandy auto Git evidence before guided Work completion", async () => {
    const fixture = await projectLedgerFixture();
    const workspacePath = gitWorkspaceFixture(fixture.root);
    fixture.core.createWork(fixture.projectRoot, {
      project: fixture.projectRoot,
      id: "W-SANDY-AUTO-EVIDENCE",
      title: "Sandy automatic commit evidence",
      status: "in_progress",
      acceptance: "The guided completion records canonical Git evidence",
      "spec-exemption": true,
      "requires-commit-evidence": true,
    });

    const effect = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_work_complete",
      args: {
        id: "W-SANDY-AUTO-EVIDENCE",
        validation: "All Sandy validation passed",
        review: "The Sandy result satisfies the request",
        report: "Sandy was deployed successfully",
        code_commit: "auto",
        code_commits: JSON.stringify([{
          hash: "aeed0e857b88aa46e02cc9e4bf2676b745fc0b31",
          branch: "main",
          remote: "origin/main",
          message: "fix: rotate logs and keep raw response history",
        }]),
      },
      butlerData: fixture.butlerData,
      projectRoot: fixture.projectRoot,
      projectRef: "fixture",
      workspacePath,
      resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
    });

    const normalizedCommits = JSON.parse(
      String(effect.normalizedInput.codeCommits),
    );
    expect(normalizedCommits).toEqual([expect.objectContaining({
      repo: "workspace",
      hash: expect.stringMatching(/^[0-9a-f]{12}$/u),
      message: "Initialize Sandy workspace",
      branch: "main",
    })]);
    expect(effect.normalizedInput).not.toHaveProperty("code_commit");
    expect(await effect.adapter.dispatch(effectDispatch("sandy-auto-evidence")))
      .toMatchObject({ status: "applied" });

    const completed = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "work",
      id: "W-SANDY-AUTO-EVIDENCE",
    });
    expect(fixture.core.readRecordData(completed.filePath)).toMatchObject({
      status: "done",
      codeCommits: JSON.stringify(normalizedCommits),
    });
  });

  test("keeps Butler operational when guided auto evidence cannot find Git", async () => {
    const fixture = await projectLedgerFixture();
    const priorExecutable = process.env.BUTLER_GIT_EXECUTABLE;
    process.env.BUTLER_GIT_EXECUTABLE = join(fixture.root, "missing-git");
    const reference = exactAppBinding(fixture.projectRoot)();
    const projectLedgerResolver = {
      clear() {},
      resolve() {
        return reference;
      },
    } as unknown as ActiveProjectLedgerResolver;
    const resolveEffect = createGuidedPersistentEffectResolver({
      butlerHome: fixture.root,
      butlerData: fixture.butlerData,
      workspacePath: fixture.root,
      projectId: "fixture",
      trackingMode: "ledger",
      projectLedgerResolver,
      effectJournal: { find: () => null },
      originalRequest: "Complete Sandy work",
    });
    try {
      const result = await resolveEffect({
        name: "project_ledger_work_complete",
        args: {
          id: "W-SANDY-AUTO-EVIDENCE",
          validation: "passed",
          review: "accepted",
          report: "completed",
          code_commit: "auto",
        },
        rawArguments: "{}",
      }, async () => ({}), {} as GuidedPersistentEffectContext);
      expect(result).toEqual({
        error: {
          code: "git_not_installed",
          message: expect.stringContaining("Butler can continue without Git"),
          recoverable: true,
        },
      });
    } finally {
      if (priorExecutable === undefined) {
        delete process.env.BUTLER_GIT_EXECUTABLE;
      } else {
        process.env.BUTLER_GIT_EXECUTABLE = priorExecutable;
      }
    }
  });

  test("does not initialize an empty Ledger for update or completion calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-project-ledger-no-init-"));
    roots.push(root);
    const projectRoot = join(root, "project-ledger", "projects", "fixture");
    let initializeCalls = 0;
    const effect = createGuidedProjectLedgerEffectAdapter({
      name: "project_ledger_work_complete",
      args: {
        id: "W-MISSING",
        validation: "No validation exists",
        review: "No Work exists",
        report: "No report exists",
      },
      butlerData: join(root, "butler-data"),
      projectRoot,
      projectRef: "fixture",
      resolveActiveProjectReference: exactAppBinding(projectRoot),
      initializeForCreate() {
        initializeCalls += 1;
      },
    });

    expect(await effect.adapter.reconcile({
      ...effectDispatch("complete-missing-work"),
      dispatchAttempts: 0,
    })).toEqual({ status: "not_applied" });
    expect(await effect.adapter.dispatch(effectDispatch("complete-missing-work")))
      .toMatchObject({
        status: "not_applied",
        error: { code: "project_ledger_not_initialized" },
      });
    expect(initializeCalls).toBe(0);
    expect(existsSync(projectRoot)).toBe(false);
  });

  test("fails closed before mutation without the exact bounded project context", async () => {
    const fixture = await projectLedgerFixture();
    const before = fixture.core.observeProjectLedgerSourceHead(
      fixture.projectRoot,
    );
    const invalidBindings: Array<Partial<ActiveProjectLedgerReference>> = [{
      app_project_id: "other-app-project",
    }, {
      ledger_root: join(fixture.root, "other-ledger-root"),
    }];

    for (const [index, override] of invalidBindings.entries()) {
      const effect = createGuidedProjectLedgerEffectAdapter({
        name: "project_ledger_create",
        args: {
          kind: "report",
          id: `REPORT-BOUNDARY-${index}`,
          title: "Must not be published",
        },
        butlerData: fixture.butlerData,
        projectRoot: fixture.projectRoot,
        projectRef: "fixture",
        resolveActiveProjectReference: exactAppBinding(
          fixture.projectRoot,
          override,
        ),
      });

      expect(await effect.adapter.reconcile({
        ...effectDispatch(`binding-reconcile-${index}`),
        dispatchAttempts: 0,
      })).toMatchObject({
        status: "uncertain",
        error: { code: "project_ledger_active_context_required" },
      });
      expect(await effect.adapter.dispatch(
        effectDispatch(`binding-dispatch-${index}`),
      )).toMatchObject({
        status: "not_applied",
        error: { code: "project_ledger_active_context_required" },
      });
    }

    expect(fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot))
      .toEqual(before);
    expect(observedOccurrences(fixture.butlerData)).toHaveLength(0);
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
    const completedWork = fixture.core.resolveRecord(fixture.projectRoot, {
      kind: "work",
      id: "W-R3",
    });
    expect(completedWork.record.status).toBe("done");
    expect(completedWork.record.spec).toBe("SPEC-R3");
    expect(completedWork.record.specExemption).toBe(false);
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
      resolveActiveProjectReference: exactAppBinding("/tmp/unused-project"),
    })).toThrow("differs from the active project");
  });
});

function exactAppBinding(
  projectRoot: string,
  overrides: Partial<ActiveProjectLedgerReference> = {},
): () => ActiveProjectLedgerReference {
  return () => ({
    schema_version: ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA,
    app_project_id: "fixture",
    workspace_path: projectRoot,
    ledger_project_id: "legacy-fixture-alias",
    ledger_root: projectRoot,
    source: "workspace_metadata",
    resolved_at: "2026-07-31T00:00:00.000Z",
    initialized: existsSync(join(projectRoot, "project.json")),
    initialization_generation: "test",
    ...overrides,
  });
}

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
    resolveActiveProjectReference: exactAppBinding(fixture.projectRoot),
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

function gitWorkspaceFixture(root: string): string {
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "README.md"), "# Sandy workspace\n");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Butler Test"],
    ["config", "user.email", "butler-test@example.invalid"],
    ["add", "README.md"],
    ["commit", "-m", "Initialize Sandy workspace"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: workspacePath,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    }
  }
  return workspacePath;
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

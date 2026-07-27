import { Database } from "bun:sqlite";
import { SqliteWorkLedgerStorage } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { SqliteTurnStateRepository } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { SqliteRuntimeOwnerRegistry } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import type { WorkLedgerCommit } from "../../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { contentRef, stableJson } from "../../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { canonicalMutationId } from "./btcc-project-ledger-fixture.ts";
import { authorPlanCandidate } from
  "../../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import {
  seedManagedProgramForStop,
  type Program,
} from "./btcc-stopped-work-fixture.ts";
import { insertManagedTurn, insertRecord, planAuthoringState, planSubmission, planningAccepted, requireProgram, sessionProgramCommit } from "./btcc-stopped-work-fixture-internals.ts";

export async function seedResultSubmittedStoppedProgram(
  db: Database,
): Promise<SqliteWorkLedgerStorage> {
  const { storage, program } = seedManagedProgramForStop(db);
  return stopWithSubmittedResult(db, storage, program);
}

export async function seedSingleResultSubmittedStoppedProgram(
  db: Database,
): Promise<SqliteWorkLedgerStorage> {
  return seedSingleSubmittedProgram(db, false);
}

export async function seedSingleWorkspaceResultSubmittedStoppedProgram(
  db: Database,
): Promise<SqliteWorkLedgerStorage> {
  return seedSingleSubmittedProgram(db, true);
}

async function seedSingleSubmittedProgram(
  db: Database,
  workspaceArtifact: boolean,
): Promise<SqliteWorkLedgerStorage> {
  const storage = new SqliteWorkLedgerStorage(db);
  storage.commit(sessionProgramCommit());
  const initial = requireProgram(storage);
  const plan = authorPlanCandidate(
    planSubmission(initial, ["c"], workspaceArtifact),
    planAuthoringState(initial),
  );
  const commit: WorkLedgerCommit = {
    mutationId: "",
    turnId: "turn-plan-one",
    expectedTurnRevision: 4,
    mutation: { kind: "install_reviewed_plan", product: planningAccepted(plan) },
  };
  commit.mutationId = canonicalMutationId(commit, initial);
  storage.commit(commit);
  db.query("UPDATE btcc_tasks SET status = 'selected' WHERE task_id = ?")
    .run(plan.tasks[0]!.ref.id);
  db.query("UPDATE btcc_work_items SET status = 'active' WHERE program_id = ?")
    .run(plan.programId);
  const selected = requireProgram(storage);
  insertManagedTurn(db, selected);
  return stopWithSubmittedResult(
    db,
    storage,
    selected,
    workspaceArtifact ? "workspace_artifact" : "non_artifact",
  );
}

async function stopWithSubmittedResult(
  db: Database,
  storage: SqliteWorkLedgerStorage,
  program: Program,
  resultKind: "non_artifact" | "workspace_artifact" = "non_artifact",
): Promise<SqliteWorkLedgerStorage> {
  if (program.planningState !== "reviewed") throw new Error("Reviewed fixture Program expected");
  const task = program.tasks.find((item) => item.task.taskLogicalId === "task-c")?.task;
  if (!task) throw new Error("Fixture Task C expected");
  const attemptBody = {
    turnId: "turn-user-stopped",
    programId: program.programId,
    taskRef: task.ref,
    attemptOrdinal: 1,
  };
  const attemptRef = contentRef("attempt", attemptBody);
  const targetRef = contentRef("task-execution-target", { taskRef: task.ref });
  const workspaceRef = contentRef("program-artifact-workspace", { taskRef: task.ref });
  const bindingRef = contentRef("attempt-execution-target-binding", {
    attemptRef, executionTargetRef: targetRef,
  });
  const operationResultRefs = [
    contentRef("operation-result", { occurrence: 1, taskRef: task.ref }),
    contentRef("operation-result", { occurrence: 2, taskRef: task.ref }),
  ];
  const resultBase = {
    turnId: "turn-user-stopped",
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    workRef: program.currentWork.work.ref,
    taskRef: task.ref,
    taskRevisionSha256: task.ref.sha256,
    attemptRef,
    executionTargetRef: targetRef,
    executionCheckpointRef: "checkpoint:result-submitted",
    resultSummary: {
      ref: contentRef("result-summary", { content: "The operation ran exactly once." }),
      content: "The operation ran exactly once.",
    },
    operationResultRefs,
    operationResultReadScopeRefs: ["operation-result:read:first", "operation-result:read:second"],
    unresolvedConditionRefs: [] as [],
    targetStateRevisions: [],
    effectReceiptRefs: [] as [],
  };
  const workspaceRevisionBody = {
    workspaceRef,
    producingWorkRef: program.currentWork.work.ref,
    producingTaskRef: task.ref,
    producingAttemptRef: attemptRef,
    baseAcceptedRevisionRefs: [],
    artifactRevisionRefs: [],
    targetSnapshotRef: contentRef("target-snapshot", { taskRef: task.ref }),
    producedByOperationRefs: operationResultRefs,
  };
  const workspaceRevision = {
    ref: contentRef("workspace-revision", workspaceRevisionBody),
    ...workspaceRevisionBody,
  };
  const resultBody = resultKind === "workspace_artifact"
    ? {
        ...resultBase,
        kind: "workspace_artifact" as const,
        workspaceRef,
        workspaceRevisionRef: workspaceRevision.ref,
        workspaceRevision,
        artifactRevisionRefs: [],
      }
    : { ...resultBase, kind: "non_artifact" as const, artifactRevisionRefs: [] as [] };
  const resultRef = contentRef("result-candidate", resultBody);
  insertRecord(db, "attempt", attemptRef, { ref: attemptRef, ...attemptBody });
  insertRecord(db, "task_execution_target", targetRef, {
    ref: targetRef,
    taskRef: task.ref,
    target: resultKind === "workspace_artifact"
      ? { kind: "provisioned_workspace", workspaceRef }
      : { kind: "scope", scopeRef: "session:session-fixture" },
  });
  insertRecord(db, "attempt_execution_target_binding", bindingRef, {
    ref: bindingRef, attemptRef, executionTargetRef: targetRef,
  });
  insertRecord(db, "result_candidate", resultRef, { ref: resultRef, ...resultBody });
  if (resultKind === "workspace_artifact") {
    insertRecord(db, "workspace_revision", workspaceRevision.ref, workspaceRevision);
  }
  for (const [index, ref] of operationResultRefs.entries()) {
    insertRecord(db, "operation_result", ref, {
      ref, output: `completed occurrence ${index + 1}`,
    });
  }
  db.query(`
    INSERT INTO btcc_attempts (
      attempt_id, program_id, task_id, attempt_ref, previous_attempt_id,
      correction_plan_ref, execution_target_ref, execution_target_binding_ref,
      status, result_ref
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'result_submitted', ?)
  `).run(
    attemptRef.id,
    program.programId,
    task.ref.id,
    stableJson(attemptRef),
    stableJson(targetRef),
    stableJson(bindingRef),
    resultRef.id,
  );
  db.query(`
    UPDATE btcc_tasks SET status = 'result_submitted', current_attempt_id = ?, result_ref = ?
    WHERE task_id = ?
  `).run(attemptRef.id, resultRef.id, task.ref.id);
  db.query("UPDATE btcc_turns SET semantic_state = 'task_review' WHERE turn_id = ?")
    .run("turn-user-stopped");
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "result-submitted-stop-fixture",
    hostId: "test-host",
    processId: 3,
    processStartedAtMs: 3,
  }, { isAlive: () => true });
  const stopped = await new SqliteTurnStateRepository(db, owner)
    .stopTurn("turn-user-stopped");
  owner.close();
  if (stopped.kind !== "cancelled") throw new Error("Fixture Turn was not stopped");
  return storage;
}


import { Database } from "bun:sqlite";
import { SqliteWorkLedgerStorage } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { SqliteTurnStateRepository } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { SqliteRuntimeOwnerRegistry } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { canonicalMutationId } from "./btcc-project-ledger-fixture.ts";
import type { WorkLedgerCommit } from "../../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import type { ReviewedManagedProgramState } from "../../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";
import {
  authorPlanCandidate,
  authorPlanningProposal,
} from "../../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import type { discoverContinuationCandidates } from "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { fourTaskPlan, insertManagedTurn, planningAccepted, planAuthoringState, planSubmission, requireProgram, seedFrontier, sessionProgramCommit, stoppedBindingCommit } from "./btcc-stopped-work-fixture-internals.ts";

export type Storage = SqliteWorkLedgerStorage;
export type Program = NonNullable<ReturnType<Storage["loadProgram"]>>;
export type StoppedCandidate = Awaited<ReturnType<typeof discoverContinuationCandidates>>[number];

export async function seedStoppedProgram(
  db: Database,
): Promise<SqliteWorkLedgerStorage> {
  const { storage } = seedManagedProgramForStop(db);
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "stopped-program-fixture",
    hostId: "test-host",
    processId: 1,
    processStartedAtMs: 1,
  }, { isAlive: () => true });
  const stopped = await new SqliteTurnStateRepository(db, owner)
    .stopTurn("turn-user-stopped");
  owner.close();
  if (stopped.kind !== "cancelled") throw new Error("Fixture Turn was not stopped");
  return storage;
}
export function seedManagedProgramForStop(
  db: Database,
  projectRef?: string,
) {
  const storage = new SqliteWorkLedgerStorage(db);
  storage.commit(sessionProgramCommit());
  const initial = requireProgram(storage);
  const plan = fourTaskPlan(initial);
  const commit: WorkLedgerCommit = {
    mutationId: "",
    turnId: "turn-plan-four",
    expectedTurnRevision: 4,
    mutation: { kind: "install_reviewed_plan", product: planningAccepted(plan) },
  };
  commit.mutationId = canonicalMutationId(commit, initial);
  storage.commit(commit);
  seedFrontier(db, plan);
  const program = requireProgram(storage);
  insertManagedTurn(db, program, projectRef);
  return { storage, program };
}

export function bindAndContinue(
  storage: SqliteWorkLedgerStorage,
  continuation: StoppedCandidate,
  mutatePlan?: (candidate: ReturnType<typeof fourTaskPlan>) => void,
): void {
  const rebound = bindStoppedContinuation(storage, continuation);
  const plan = authorPlanCandidate(
    { kind: "stopped_plan_resume" },
    planAuthoringState(rebound, continuation),
  );
  mutatePlan?.(plan);
  const commit: WorkLedgerCommit = {
    mutationId: "",
    turnId: "turn-fresh-continuation",
    expectedTurnRevision: 8,
    mutation: { kind: "install_reviewed_plan", product: planningAccepted(plan) },
  };
  commit.mutationId = canonicalMutationId(commit, rebound);
  storage.commit(commit);
}

export function bindStoppedContinuation(
  storage: SqliteWorkLedgerStorage,
  continuation: StoppedCandidate,
): Program {
  const current = requireProgram(storage);
  const bind = stoppedBindingCommit(continuation);
  bind.mutationId = canonicalMutationId(bind, current);
  storage.commit(bind);
  return requireProgram(storage);
}

export function authorReplannedStoppedTask(
  authority: Program,
  continuation: StoppedCandidate,
) {
  return authorPlanningProposal(
    planSubmission(authority, ["a", "b", "c", "d"]),
    planAuthoringState(authority, continuation),
  );
}

export function authorResumedStoppedPlan(
  authority: Program,
  continuation: StoppedCandidate,
) {
  return authorPlanningProposal(
    { kind: "stopped_plan_resume" },
    planAuthoringState(authority, continuation),
  );
}

export function continuedPlanningAccepted(
  authority: Program,
  continuation: StoppedCandidate,
) {
  return planningAccepted(authorPlanCandidate(
    { kind: "stopped_plan_resume" },
    planAuthoringState(authority, continuation),
  ));
}

export function freshContinuationCommand() {
  return {
    kind: "run" as const,
    turnId: "turn-fresh-continuation",
    sessionId: "session-fixture",
    triggerKey: "message:fresh-continuation",
    message: { messageId: "message-fresh-continuation", content: "Continue the work" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high" as const,
      controls: { reasoningEffort: "high" as const },
      controlsHash: "fresh-controls-hash",
    },
    context: {
      userRef: "user:fixture",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
  };
}

export function acceptedGoalFixture() {
  const commit = sessionProgramCommit();
  if (commit.mutation.kind !== "bind_program") throw new Error("Goal fixture expected");
  return commit.mutation.product;
}

export function taskStatuses(db: Database): string[] {
  return db.query<{ status: string }, []>(
    "SELECT status FROM btcc_tasks WHERE is_active = 1 ORDER BY rowid",
  ).all().map((row) => row.status);
}

export function closeManagedProgramForFinalization(
  db: Database,
  storage: SqliteWorkLedgerStorage,
): ReviewedManagedProgramState {
  db.query("UPDATE btcc_tasks SET status = 'accepted' WHERE is_active = 1").run();
  db.query("UPDATE btcc_work_items SET status = 'closed' WHERE is_active = 1").run();
  db.query("UPDATE btcc_programs SET frontier = 'closed'").run();
  const program = storage.loadProgram("program-session");
  if (!program || program.planningState !== "reviewed" || program.frontier !== "closed") {
    throw new Error("Closed finalization Program expected");
  }
  return program;
}

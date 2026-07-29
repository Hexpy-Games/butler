import { Database } from "bun:sqlite";
import type { WorkLedgerCommit } from "../../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { contentRef, stableJson } from "../../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { authorPlanCandidate } from "../../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import { planningReviewSubjects } from "../../../packages/butler-agent/src/agent/btcc/planning/review-subjects.ts";
import { canonicalMutationId } from "./btcc-project-ledger-fixture.ts";
import type { Program, Storage, StoppedCandidate } from "./btcc-stopped-work-fixture.ts";

export function sessionProgramCommit(): WorkLedgerCommit {
  const ref = (id: string) => ({ id, sha256: `${id}-sha256` });
  const commit: WorkLedgerCommit = {
    mutationId: "",
    turnId: "turn-session",
    expectedTurnRevision: 1,
    mutation: {
      kind: "bind_program",
      sessionId: "session-fixture",
      product: {
        kind: "goal_contract_accepted",
        planningContext: { observationResultIndex: [] },
        review: {
          ref: ref("review"),
          candidateRef: ref("candidate"),
          originalMessageId: "message",
          originalMessageSha256: "message-sha256",
          originalGoalContractRef: ref("goal"),
          reviewedLensIds: [],
          reviewedFieldIds: ["request", "intended_result"],
          reviewedOutcomeIds: ["required-outcome"],
          reviewedArtifactPersistence: "not_required",
          continuationBindingRef: ref("continuation"),
          continuationDecision: { kind: "new_request" },
          verdict: "accepted",
          findings: [],
        },
        goalContract: {
          ref: ref("goal"),
          originalMessageId: "message",
          originalMessageSha256: "message-sha256",
          request: "Complete four tasks",
          intendedResult: "All tasks complete",
          acceptanceIntent: "Every task is reviewed",
          artifactPersistence: "not_required",
          fields: [
            { fieldId: "request", semanticRole: "required_outcome", statement: "Complete" },
            { fieldId: "intended_result", semanticRole: "required_outcome", statement: "Done" },
          ],
          requiredOutcome: {
            outcomeId: "required-outcome",
            sourceGoalFieldIds: ["request", "intended_result"],
          },
          lensAssessments: {} as never,
          personalizationRefs: [],
          governingSpecApplications: [],
          nonGoals: [],
        },
        authority: {
          ref: ref("authority"),
          goalContractRef: ref("goal"),
          route: "managed",
          ledgerScope: { kind: "session", sessionId: "session-fixture" },
          managedBinding: {
            ledgerId: "session:session-fixture",
            programId: "program-session",
            expectedManifestRevision: 0,
            source: "new_program",
            continuationBinding: {
              kind: "new_request",
              inboxId: "inbox-session",
              ref: ref("continuation"),
            },
          },
        },
      },
    },
  };
  commit.mutationId = canonicalMutationId(commit, null);
  return commit;
}

export function fourTaskPlan(authority: Program, continuation?: StoppedCandidate) {
  const stoppedResult = continuation?.context?.frontier.interruptedTask?.resultRef;
  const suffixes = stoppedResult
    ? []
    : continuation
      ? ["c", "d"]
      : ["a", "b", "c", "d"];
  return authorPlanCandidate(
    planSubmission(authority, suffixes),
    planAuthoringState(authority, continuation),
  );
}

export function planSubmission(
  authority: Program,
  suffixes: string[],
  workspaceArtifact = false,
) {
  return {
    strategy: "Complete four dependent tasks in order.",
    works: suffixes.length === 0 ? [] : [{
      logicalId: "continued-work",
      outcome: "All four reviewed tasks are complete.",
      dependencyWorkIds: [],
      tasks: suffixes.map((suffix, index) => ({
        logicalId: `task-${suffix}`,
        displayTitle: `Task ${suffix.toUpperCase()}`,
        intendedOutcome: `Complete task ${suffix.toUpperCase()}.`,
        dependencyTaskIds: index === 0 ? [] : [`task-${suffixes[index - 1]}`],
        targetScopeRefs: ["session:session-fixture"],
        effectClass: "none",
        ...(workspaceArtifact
          ? {
              artifactPolicy: {
                kind: "workspace_artifact",
                workspacePath: ".",
                mutationScope: { kind: "contained_paths", writablePaths: ["result.txt"] },
              },
            }
          : {}),
        criteria: [{
          statement: `Task ${suffix.toUpperCase()} is complete.`,
          question: `Is task ${suffix.toUpperCase()} complete?`,
          sourceGoalFieldIds: ["request", "intended_result"],
          sourceRequiredOutcomeRefs: [authority.requiredOutcomeId],
        }],
      })),
    }],
    risks: [], assumptions: [], effectIntents: [], integrationCriteria: [], promotionSelectors: [],
  };
}

export function planAuthoringState(authority: Program, continuation?: StoppedCandidate) {
  return {
    ledgerId: authority.ledgerId,
    programId: authority.programId,
    observedManifestRevision: authority.manifestRevision,
    goalContractRef: authority.goalContractRef,
    authorityRef: authority.authorityRef,
    governingSpecRefs: authority.governingSpecRefs,
    availableSpecs: authority.availableSpecs,
    requiredOutcomeId: authority.requiredOutcomeId,
    artifactPersistence: "not_required" as const,
    workspaceScopeRef: "workspace:/session-fixture",
    ...(continuation ? { continuation: continuationBinding(continuation) } : {}),
  };
}

export function planningAccepted(candidate: ReturnType<typeof fourTaskPlan>) {
  const reviewBody = {
    candidateRef: candidate.ref,
    originalGoalContractRef: candidate.goalContractRef,
    reviewedBundleRef: candidate.bundle.ref,
    reviewedWorkGraphRef: candidate.workGraph.ref,
    reviewedWorkRefs: candidate.works.map((work) => work.ref),
    reviewedTaskRefs: candidate.tasks.map((task) => task.ref),
    reviewedCriterionRefs: candidate.criteria.map((criterion) => criterion.ref),
    reviewedVerificationQuestionRefs: candidate.verificationQuestions.map((item) => item.ref),
    reviewedEffectIntentRefs: candidate.effectIntents.map((item) => item.ref),
    reviewedIntegrationCriterionRefs: candidate.integrationCriteria.map((item) => item.ref),
    reviewedArtifactLifecycleRef: candidate.artifactLifecycle.ref,
    reviewedSpecRevisionRefs: candidate.authoredSpecRevisionRefs,
    reviewedSubjects: planningReviewSubjects(candidate).map((subject) => ({
      ...subject, verdict: "passed" as const, findings: [],
    })),
    coverage: planningCoverage(),
    verdict: "accepted" as const,
    findings: [] as [],
    findingVerdicts: [],
  };
  return {
    kind: "planning_accepted" as const,
    candidate,
    review: { ref: contentRef("planning-review", reviewBody), ...reviewBody },
  };
}

export function seedFrontier(db: Database, plan: ReturnType<typeof fourTaskPlan>): void {
  for (const task of plan.tasks.slice(0, 2)) seedAcceptedTask(db, task);
  db.query("UPDATE btcc_tasks SET status = 'selected' WHERE task_id = ?")
    .run(plan.tasks[2]!.ref.id);
  db.query("UPDATE btcc_work_items SET status = 'active' WHERE program_id = ?")
    .run(plan.programId);
}

function seedAcceptedTask(db: Database, task: ReturnType<typeof fourTaskPlan>["tasks"][number]) {
  const resultBody = { kind: "result_candidate", taskRef: task.ref };
  const resultRef = contentRef("result", resultBody);
  const reviewBody = { kind: "task_review", taskRef: task.ref, verdict: "passed" };
  const reviewRef = contentRef("task-review", reviewBody);
  insertRecord(db, "result", resultRef, { ref: resultRef, ...resultBody });
  insertRecord(db, "task_review", reviewRef, { ref: reviewRef, ...reviewBody });
  db.query(`
    UPDATE btcc_tasks SET status = 'accepted', result_ref = ?, review_ref = ?
    WHERE task_id = ?
  `).run(resultRef.id, reviewRef.id, task.ref.id);
}

export function insertManagedTurn(
  db: Database,
  program: Program,
  projectRef?: string,
): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state, route,
      managed_state_json, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "turn-user-stopped", "session-fixture", "inbox-user-stopped",
    "message:user-stopped", "message-user-stopped", "Start the four-task Program",
    "snapshot-user-stopped", stableJson({ provider: "openai", model: "gpt-5.6-sol" }),
    stableJson(projectRef ? { projectRef } : {}), stableJson([]),
    "task_execution", "managed",
    stableJson({ programId: program.programId, selectedTaskId: "task-c" }), 7, 0,
  );
}

export function stoppedBindingCommit(continuation: StoppedCandidate): WorkLedgerCommit {
  const commit = sessionProgramCommit();
  if (commit.mutation.kind !== "bind_program") throw new Error("Bind fixture expected");
  commit.turnId = "turn-fresh-continuation";
  commit.mutation.product.authority.ref = {
    id: "authority-stopped", sha256: "authority-stopped-sha256",
  };
  const continuedGoalRef = {
    id: "goal-fresh-continuation",
    sha256: "goal-fresh-continuation-sha256",
  };
  commit.mutation.product.goalContract.ref = continuedGoalRef;
  commit.mutation.product.review.ref = {
    id: "review-fresh-continuation",
    sha256: "review-fresh-continuation-sha256",
  };
  commit.mutation.product.review.originalGoalContractRef = continuedGoalRef;
  commit.mutation.product.authority.goalContractRef = continuedGoalRef;
  commit.mutation.product.authority.managedBinding = {
    ledgerId: continuation.ledgerId,
    programId: continuation.programId,
    expectedManifestRevision: continuation.expectedManifestRevision,
    source: "stopped_program",
    continuationBinding: continuationBinding(continuation),
  };
  return commit;
}

function continuationBinding(continuation: StoppedCandidate) {
  return {
    kind: "stopped_program" as const,
    inboxId: "inbox-fresh-continuation",
    ref: { id: "continuation-stopped", sha256: "continuation-stopped-sha256" },
    ...continuation,
  };
}

export function requireProgram(storage: Storage): Program {
  const program = storage.loadProgram("program-session");
  if (!program) throw new Error("Session Program expected");
  return program;
}

export function insertRecord(
  db: Database,
  kind: string,
  ref: { id: string; sha256: string },
  body: unknown,
): void {
  db.query(`
    INSERT INTO btcc_records (record_id, kind, sha256, content_json) VALUES (?, ?, ?, ?)
  `).run(ref.id, kind, ref.sha256, stableJson(body));
}

function planningCoverage() {
  const dimensions = [
    "original_goal", "governing_specs", "work_cohesion", "task_executability",
    "dependencies", "verification_integration", "effect_authority", "artifact_lifecycle",
  ] as const;
  return dimensions.map((dimension) => ({
    dimension,
    verdict: "passed" as const,
    findings: [],
  }));
}

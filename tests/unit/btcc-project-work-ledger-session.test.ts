import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SqliteWorkLedgerStorage } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import type { WorkLedgerCommit } from
  "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { canonicalMutationId } from "./support/btcc-project-ledger-fixture.ts";
import {
  clearProjectFixtures,
  projectBindingCommit,
  projectFixture,
} from "./support/btcc-project-ledger-fixture.ts";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  assertLogicalLedgerRecordBytes,
  contentRef,
  stableJson,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";
import { authorPlanCandidate } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";

afterEach(clearProjectFixtures);

describe("BTCC Session Work Ledger selection", () => {
  test("keeps unbound managed work in the SQLite Session Ledger", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const storage = new SqliteWorkLedgerStorage(db);
    storage.commit(sessionProgramCommit());

    const row = db.query<{
      ledger_id: string;
      scope_kind: string;
      scope_id: string;
    }, []>("SELECT ledger_id, scope_kind, scope_id FROM btcc_programs").get();
    expect(row).toEqual({
      ledger_id: "session:session-fixture",
      scope_kind: "session",
      scope_id: "session-fixture",
    });
    db.close();
  });

  test("atomically publishes and reloads one independently reviewed Session Program", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const storage = new SqliteWorkLedgerStorage(db);
    const bind = sessionProgramCommit();
    if (bind.mutation.kind !== "bind_program") throw new Error("Session bind fixture expected");
    storage.commit(bind);
    const bound = storage.loadProgram("program-session");
    if (!bound) throw new Error("bound Session Program expected");
    const candidate = sessionPlan(bound);
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
      coverage: acceptedPlanningCoverage(),
      verdict: "accepted" as const,
      findings: [] as [],
    };
    const review = { ref: contentRef("planning-review", reviewBody), ...reviewBody };
    const product = { kind: "planning_accepted" as const, candidate, review };
    const commit: WorkLedgerCommit = {
      mutationId: "",
      turnId: "turn-session-plan",
      expectedTurnRevision: 4,
      mutation: { kind: "install_reviewed_plan", product },
    };
    commit.mutationId = canonicalMutationId(commit, bound);

    storage.commit(commit);

    expect(storage.loadProgram("program-session")).toMatchObject({
      planningState: "reviewed",
      manifestRevision: 2,
      goalContractRef: bound.goalContractRef,
      authorityRef: bound.authorityRef,
      governingSpecRefs: [],
      works: [{ status: "planned" }],
      tasks: [{ status: "planned" }],
      frontier: "implementation_open",
    });
    db.close();
  });

  test("keeps Project publication out of the Session Ledger adapter", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({
      stagingRoot: join(fixture.root, "staging"),
    });
    const commit = projectBindingCommit({ governingSpecLogicalIds: [] }).commit;
    const prepared = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot,
      expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
      commit,
    });
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    expect(() => new SqliteWorkLedgerStorage(db).commit(commit))
      .toThrow("Session Work Ledger received a Project-bound Program");
    expect(prepared.program.ledgerId).toBe("project:fixture-project");
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_programs",
    ).get()?.count).toBe(0);
    db.close();
  });

  test("rejects a commit whose caller-supplied mutationId is not canonical", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const commit = sessionProgramCommit();
    commit.mutationId = "caller-selected-mutation-id";

    expect(() => new SqliteWorkLedgerStorage(db).commit(commit))
      .toThrow("mutationId does not match");
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_ledger_claims",
    ).get()?.count).toBe(0);
    db.close();
  });

  test("rejects a fresh Session Program with a nonzero manifest base", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const commit = sessionProgramCommit();
    if (commit.mutation.kind !== "bind_program") throw new Error("Session bind fixture expected");
    commit.mutation.product.authority.managedBinding.expectedManifestRevision = 1;
    commit.mutationId = canonicalMutationId(commit, null);

    expect(() => new SqliteWorkLedgerStorage(db).commit(commit))
      .toThrow("new Program binding is invalid");
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_programs",
    ).get()?.count).toBe(0);
    db.close();
  });

  test("rejects the former unprefixed SHA-256 form as a logical Ledger record", () => {
    const id = "ledger-record:legacy";
    const bytes = stableJson({ ref: { id }, sourceId: "legacy", record: { value: 1 } });
    const legacySha = createHash("sha256").update(bytes).digest("hex");

    expect(() => assertLogicalLedgerRecordBytes({ id, sha256: legacySha }, bytes))
      .toThrow("logical record identity is invalid");
  });
});

function acceptedPlanningCoverage() {
  const dimensions = [
    "original_goal",
    "governing_specs",
    "work_cohesion",
    "task_executability",
    "dependencies",
    "verification_integration",
    "effect_authority",
    "artifact_lifecycle",
  ] as const;
  return dimensions.map((dimension) => ({
    dimension,
    verdict: "passed" as const,
    findings: [],
  }));
}

function sessionProgramCommit(): WorkLedgerCommit {
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
          verdict: "accepted",
          findings: [],
        },
        goalContract: {
          ref: ref("goal"),
          originalMessageId: "message",
          originalMessageSha256: "message-sha256",
          request: "Research products",
          intendedResult: "A report",
          acceptanceIntent: "Ranked products",
          artifactPersistence: "not_required",
          fields: [
            { fieldId: "request", semanticRole: "required_outcome", statement: "Research" },
            { fieldId: "intended_result", semanticRole: "required_outcome", statement: "Report" },
          ],
          requiredOutcome: {
            outcomeId: "required-outcome",
            sourceGoalFieldIds: ["request", "intended_result"],
          },
          lensAssessments: {} as never,
          personalizationRefs: [],
          governingSpecLogicalIds: [],
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
            continuationBinding: { kind: "new_request", inboxId: "inbox-session", ref: ref("continuation") },
          },
        },
      },
    },
  };
  commit.mutationId = canonicalMutationId(commit, null);
  return commit;
}

function sessionPlan(
  authority: NonNullable<ReturnType<SqliteWorkLedgerStorage["loadProgram"]>>,
) {
  return authorPlanCandidate({
    strategy: "Research once, then review the complete report.",
    works: [{
      logicalId: "research-report",
      outcome: "The requested report is complete.",
      dependencyWorkIds: [],
      tasks: [{
        logicalId: "write-report",
        intendedOutcome: "Produce the reviewed report.",
        dependencyTaskIds: [],
        targetScopeRefs: ["session:session-fixture"],
        effectClass: "none",
        criteria: [{
          statement: "The report answers the accepted request.",
          question: "Does the report answer the accepted request?",
          sourceGoalFieldIds: ["request", "intended_result"],
          sourceRequiredOutcomeRefs: [authority.requiredOutcomeId],
        }],
      }],
    }],
    risks: [],
    assumptions: [],
    effectIntents: [],
    integrationCriteria: [],
    promotionSelectors: [],
  }, {
    ledgerId: authority.ledgerId,
    programId: authority.programId,
    observedManifestRevision: authority.manifestRevision,
    goalContractRef: authority.goalContractRef,
    authorityRef: authority.authorityRef,
    governingSpecRefs: authority.governingSpecRefs,
    availableSpecs: authority.availableSpecs,
    requiredOutcomeId: authority.requiredOutcomeId,
    artifactPersistence: "not_required",
    workspaceScopeRef: "workspace:/session-fixture",
  });
}

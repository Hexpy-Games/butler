import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { discoverContinuationCandidates } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { SqliteRuntimeOwnerRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { SqliteTurnStateRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { StoppedFinalizationRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/stopped-finalization-registry.ts";
import { decideContinuation } from
  "../../packages/butler-agent/src/agent/btcc/conception/continuation/index.ts";
import type { GoalContractAcceptedProduct } from
  "../../packages/butler-agent/src/agent/btcc/conception/index.ts";
import { openingAnswerCodec } from
  "../../packages/butler-agent/src/agent/btcc/conception/opening/opening-answer-codec.ts";
import type { ContinuationCandidate } from
  "../../packages/butler-agent/src/agent/btcc/continuation/index.ts";
import { contentRef, stableJson } from
  "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { digest } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type { PreparedReportProduct } from
  "../../packages/butler-agent/src/agent/btcc/reporting/index.ts";
import { decideTransition } from
  "../../packages/butler-agent/src/agent/btcc/turn/state-machine/decide-transition.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import {
  acceptedGoalFixture,
  closeManagedProgramForFinalization,
  freshContinuationCommand,
  seedManagedProgramForStop,
} from "./support/btcc-stopped-work-fixture.ts";

for (const resumeAt of ["consolidation", "reporting", "delivery"] as const) {
  test(`Stop preserves a typed ${resumeAt} continuation without reopening Work`, async () => {
    const { db, program, finalDossier, preparedReport } = finalizationTurn(resumeAt);
    const originalRevision = program.manifestRevision;
    const originalAttempts = count(db, "btcc_attempts");
    const owner = new SqliteRuntimeOwnerRegistry(db, {
      ownerId: `finalization-${resumeAt}`,
      hostId: "test-host",
      processId: 7,
      processStartedAtMs: 7,
    }, { isAlive: () => true });
    const turns = new SqliteTurnStateRepository(db, owner);

    expect(await turns.stopTurn("turn-user-stopped")).toEqual({
      kind: "cancelled",
      turnId: "turn-user-stopped",
    });
    const candidates = await discoverContinuationCandidates(
      db,
      freshContinuationCommand(),
    );
    expect(candidates).toHaveLength(1);
    const candidate = requireFinalizationCandidate(candidates[0]);
    expect(candidate.context.finalization.resumeAt).toBe(resumeAt);
    expect(programRevision(db)).toBe(originalRevision);
    expect(count(db, "btcc_attempts")).toBe(originalAttempts);
    expect(db.query<{ frontier: string }, []>(
      "SELECT frontier FROM btcc_programs",
    ).get()?.frontier).toBe("closed");

    const codec = openingAnswerCodec(candidates);
    const schema = JSON.stringify(codec.submissionSchema);
    expect(schema).toContain("managed_finalization_continuation");
    expect(schema).not.toContain("cancel_work");
    const envelope = {
      binding: { turnId: `turn-${resumeAt}-continuation` },
      context: { continuationCandidates: candidates },
    } as never;
    expect(() => codec.decode({
      kind: "cancel_work",
      continuationCandidateId: candidate.candidateId,
      reason: "Do not do this",
    }, envelope)).toThrow("cannot cancel finalization");
    const opening = codec.decode(finalizationOpening(candidate.candidateId), envelope);
    expect(opening).toMatchObject({
      kind: "opening_continuation",
      continuationMode: "managed_finalization",
      route: "managed",
      continuationProposal: { candidateId: candidate.candidateId },
    });

    const continuation = decideContinuation({
      kind: "bind",
      continuationCandidateId: candidate.candidateId,
    }, { continuationCandidates: candidates }, "inbox-finalization", candidate.candidateId);
    expect(continuation.binding.kind).toBe("stopped_finalization");
    const accepted = finalizationGoal(candidate, continuation.binding);
    const decision = decideTransition({
      turnId: `turn-${resumeAt}-continuation`,
      sessionId: "session-fixture",
      revision: 3,
      semanticState: "contract_review",
      managed: {},
    } as TurnRecord, { kind: "GoalContractReviewAccepted", product: accepted });
    expect(decision).toMatchObject({
      kind: "accepted",
      transition: {
        kind: "accept_finalization_continuation",
        successor: resumeAt === "delivery" ? "delivery_committed" : resumeAt,
      },
    });
    if (decision.kind === "accepted" && resumeAt === "delivery") {
      expect(decision.transition).toHaveProperty("preparedReport");
      const rebound = decision.transition as Extract<
        typeof decision.transition,
        { kind: "accept_finalization_continuation" }
      >;
      expect(rebound.preparedReport?.report.ref).toEqual(preparedReport.report.ref);
      expect(rebound.preparedReport?.finalPayload.ref).not.toEqual(
        preparedReport.finalPayload.ref,
      );
      expect(rebound.preparedReport?.finalPayload.turnId)
        .toBe(`turn-${resumeAt}-continuation`);
    }
    if (resumeAt === "reporting") {
      expect(candidate.context.finalization).toMatchObject({ finalDossier });
    }
    if (continuation.binding.kind !== "stopped_finalization") {
      throw new Error("Stopped finalization binding expected");
    }
    const binding = continuation.binding;
    const registry = new StoppedFinalizationRegistry(db);
    if (candidate.context.finalization.resumeAt === "reporting") {
      const substituted = structuredClone(candidate.context.finalization);
      substituted.finalDossier.dossier.summary = "substituted after discovery";
      expect(() => registry.consume(binding, substituted, "turn-substituted"))
        .toThrow("FinalDossier changed");
    }
    registry.consume(binding, candidate.context.finalization, `turn-${resumeAt}-continuation`);
    registry.consume(binding, candidate.context.finalization, `turn-${resumeAt}-continuation`);
    expect(() => registry.consume(binding, candidate.context.finalization, "turn-competing"))
      .toThrow("continuation changed");
    owner.close();
    db.close();
  });
}

test("finalization discovery ignores substituted mutable context_json", async () => {
  const { db, finalDossier } = finalizationTurn("reporting");
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "finalization-context-substitution",
    hostId: "test-host",
    processId: 8,
    processStartedAtMs: 8,
  }, { isAlive: () => true });
  const turns = new SqliteTurnStateRepository(db, owner);
  await turns.stopTurn("turn-user-stopped");
  db.query(`
    UPDATE btcc_stopped_finalization_continuations SET context_json = ?
  `).run(stableJson({
    originalGoalContract: { request: "substituted" },
    finalization: { resumeAt: "consolidation", closedProgram: { programId: "forged" } },
  }));
  const candidate = requireFinalizationCandidate(
    (await discoverContinuationCandidates(db, freshContinuationCommand()))[0],
  );
  expect(candidate.context.finalization).toEqual({ resumeAt: "reporting", finalDossier });
  expect(candidate.context.originalGoalContract).toEqual(acceptedGoalFixture().goalContract);
  owner.close();
  db.close();
});

function finalizationTurn(resumeAt: "consolidation" | "reporting" | "delivery") {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const seeded = seedManagedProgramForStop(db);
  const program = closeManagedProgramForFinalization(db, seeded.storage);
  const finalDossier = finalDossierFor(program);
  const preparedReport = preparedReportFor(finalDossier);
  const sourceState = resumeAt === "consolidation" ? "consolidation" : "reporting";
  const checkpointId = `checkpoint-${sourceState}`;
  const accepted = resumeAt === "delivery"
    ? preparedReport
    : resumeAt === "reporting"
      ? null
      : null;
  db.query(`
    UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?, revision = 12,
      managed_state_json = ? WHERE turn_id = 'turn-user-stopped'
  `).run(
    sourceState,
    checkpointId,
    stableJson({
      programId: program.programId,
      ...(resumeAt !== "consolidation" ? { finalDossier } : {}),
    }),
  );
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, accepted_product_json, is_active
    ) VALUES (?, 'turn-user-stopped', 12, ?, 'phase', 1, ?, 1)
  `).run(checkpointId, sourceState, accepted ? stableJson(accepted) : null);
  return { db, program, finalDossier, preparedReport };
}

function finalDossierFor(
  program: ReturnType<typeof closeManagedProgramForFinalization>,
) {
  const dossierBody = {
    programId: program.programId,
    originalGoalContractRef: program.goalContractRef,
    currentAuthorityRef: program.authorityRef,
    consolidationAssessmentRef: contentRef("assessment", { programId: program.programId }),
    acceptedPlanRef: program.acceptedPlan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: [],
    goalCoverage: "fulfilled" as const,
    semanticFidelity: "faithful" as const,
    promotionClosure: "not_required" as const,
    disposition: "completed" as const,
    summary: "The accepted work is complete.",
    userReport: {
      outcome: "alpha then omega",
      materialChanges: ["No files changed"] as [string, ...string[]],
      validationResults: ["The accepted result passed Review"] as [string, ...string[]],
      limitations: [],
    },
  };
  return {
    kind: "final_dossier" as const,
    dossier: { ref: contentRef("final-dossier", dossierBody), ...dossierBody },
  };
}

function preparedReportFor(finalDossier: ReturnType<typeof finalDossierFor>) {
  const content = "First line: alpha\nLast line: omega";
  const reportBody = {
    finalDossierRef: finalDossier.dossier.ref,
    content,
    contentSha256: digest(content),
  };
  const report = { ref: contentRef("prepared-report", reportBody), ...reportBody };
  const payloadBody = {
    turnId: "turn-user-stopped",
    reportRef: report.ref,
    finalDossierRef: finalDossier.dossier.ref,
    contentSha256: report.contentSha256,
    route: "managed" as const,
    disposition: "completed" as const,
    content,
  };
  return {
    kind: "prepared_report" as const,
    report,
    finalPayload: { ref: contentRef("payload", payloadBody), ...payloadBody },
  } satisfies PreparedReportProduct;
}

function finalizationGoal(
  candidate: Extract<ContinuationCandidate, { continuationKind: "managed_finalization" }>,
  binding: ReturnType<typeof decideContinuation>["binding"],
): GoalContractAcceptedProduct {
  if (binding.kind !== "stopped_finalization") throw new Error("Binding expected");
  const accepted = structuredClone(acceptedGoalFixture()) as GoalContractAcceptedProduct;
  accepted.authority.managedBinding = {
    ledgerId: candidate.ledgerId,
    programId: candidate.programId,
    expectedManifestRevision: candidate.expectedManifestRevision,
    source: "stopped_finalization",
    continuationBinding: binding,
  };
  accepted.review.continuationDecision = {
    kind: "bind",
    continuationCandidateId: candidate.candidateId,
  };
  return accepted;
}

function requireFinalizationCandidate(candidate: ContinuationCandidate | undefined) {
  if (!candidate || candidate.continuationKind !== "managed_finalization") {
    throw new Error("Finalization candidate expected");
  }
  return candidate;
}

function finalizationOpening(continuationCandidateId: string) {
  return {
    kind: "managed_finalization_continuation",
    requiredResultKind: "durable_work",
    continuationCandidateId,
    requestObligation: "Finish the stopped finalization",
    summary: "Resume only the accepted finalization",
    rationale: "The current request selects the exact stopped result",
    nextStep: "Review the finalization binding and resume its typed successor",
  };
}

function count(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
    .get()!.count;
}

function programRevision(db: Database): number {
  return db.query<{ manifest_revision: number }, []>(
    "SELECT manifest_revision FROM btcc_programs",
  ).get()!.manifest_revision;
}

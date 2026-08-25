import { existsSync } from "node:fs";
import {
  admitProjectLedgerEffectOccurrence,
  appendProjectLedgerEffectAttempt,
  readProjectLedgerEffectOccurrence,
  type ProjectLedgerEffectAttempt,
  type ProjectLedgerEffectOccurrence,
} from "./external-effect-occurrence.ts";
import {
  applyProjectLedgerRecordUpdate,
  type ProjectLedgerRecordUpdate,
} from "./external-effect-record-update.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import { loadProjectLedgerCore, type ProjectLedgerCore } from "./project-ledger-core.ts";
import {
  applyProjectLedgerPublicationAttempt,
  captureExactPublicationAttempt,
  hasUnsupportedLegacyProjectLedgerOccurrence,
  publicationPaths,
  reconcileProjectLedgerPublication,
  resolveExactProjectLedgerScope,
} from "./publication-recovery/index.ts";
import type {
  ProjectWorkOperationIdentity,
  ResolvedProjectWorkScope,
} from "./project-work-contracts.ts";
import {
  ProjectWorkAdapterError,
  ProjectWorkPublicationNotAppliedError,
  ProjectWorkPublicationUncertainError,
  typedProjectWorkPreparation,
} from "./project-work-errors.ts";
import {
  assertProjectWorkPublicationTargets,
  projectWorkPublicationProofUpdates,
} from "./project-work-publication-proof.ts";

type PublicationInput = {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  identity: ProjectWorkOperationIdentity;
  prepareUpdates(): Promise<ProjectLedgerRecordUpdate[] | null>;
};

export type ProjectWorkPublicationOutcome = {
  replayed: boolean;
  skipped: boolean;
  targets: ProjectLedgerEffectAttempt["targetPreconditions"];
  preparedUpdates: ProjectLedgerRecordUpdate[];
};

export async function publishProjectWorkRecords(
  input: PublicationInput,
): Promise<ProjectWorkPublicationOutcome> {
  const exact = exactScope(input.scope);
  if (
    hasUnsupportedLegacyProjectLedgerOccurrence({
      butlerData: input.butlerData,
      projectRoots: [input.scope.ledgerRoot, exact.ledgerRoot],
      effectKey: input.identity.id,
    })
  )
    throw new ProjectWorkPublicationUncertainError();
  const core = await loadProjectLedgerCore();
  let occurrence = readProjectLedgerEffectOccurrence({
    butlerData: input.butlerData,
    ledgerProjectId: exact.ledgerProjectId,
    ledgerRoot: exact.ledgerRoot,
    operationIdentity: operationIdentity(input.identity),
    requestSha256: input.identity.requestSha256,
  });

  if (!occurrence) {
    const updates = await preparedUpdates(input);
    if (!updates) return skippedOutcome();
    const snapshot = await capture(core, input.scope, updates);
    occurrence = admitProjectLedgerEffectOccurrence({
      butlerData: input.butlerData,
      ledgerProjectId: exact.ledgerProjectId,
      ledgerRoot: exact.ledgerRoot,
      operationIdentity: operationIdentity(input.identity),
      requestSha256: input.identity.requestSha256,
      expectedBase: snapshot.expectedBase,
      targetPreconditions: snapshot.targetPreconditions,
    });
    return publish(input, core, occurrence, occurrence.attempts[0]!, updates, false);
  }

  const attempt = occurrence.attempts.at(-1)!;
  const hadAttemptOutcome = existsSync(
    publicationPaths({
      butlerData: input.butlerData,
      publicationId: attempt.publicationId,
    }).receiptPath,
  );
  const recovered = await reconcileProjectLedgerPublication({
    core,
    butlerData: input.butlerData,
    ledgerRoot: occurrence.ledgerRoot,
    occurrenceId: occurrence.occurrenceId,
    attempt,
    observeHead: observeProjectLedgerHead,
  });
  if (recovered.status === "applied")
    return appliedOutcome(attempt, [], true);
  if (recovered.status === "uncertain")
    throw new ProjectWorkPublicationUncertainError();
  if (recovered.status === "ready")
    return publish(input, core, occurrence, attempt, null, true);
  if (!hadAttemptOutcome) throw new ProjectWorkPublicationNotAppliedError();

  const updates = await preparedUpdates(input);
  if (!updates) return skippedOutcome();
  const snapshot = await capture(core, input.scope, updates);
  occurrence = appendProjectLedgerEffectAttempt({
    butlerData: input.butlerData,
    ledgerProjectId: exact.ledgerProjectId,
    ledgerRoot: exact.ledgerRoot,
    operationIdentity: operationIdentity(input.identity),
    requestSha256: input.identity.requestSha256,
    afterAttemptNumber: attempt.number,
    expectedBase: snapshot.expectedBase,
    targetPreconditions: snapshot.targetPreconditions,
  });
  return publish(input, core, occurrence, occurrence.attempts.at(-1)!, updates, false);
}

async function publish(
  input: PublicationInput,
  core: ProjectLedgerCore,
  occurrence: ProjectLedgerEffectOccurrence,
  attempt: ProjectLedgerEffectAttempt,
  updates: ProjectLedgerRecordUpdate[] | null,
  replayed: boolean,
): Promise<ProjectWorkPublicationOutcome> {
  if (updates)
    assertProjectWorkPublicationTargets(updates, attempt.targetPreconditions);
  const result = await applyProjectLedgerPublicationAttempt({
    core,
    butlerData: input.butlerData,
    ledgerRoot: occurrence.ledgerRoot,
    occurrenceId: occurrence.occurrenceId,
    attempt,
    observeHead: observeProjectLedgerHead,
    runPhase: (_phase, run) => run(),
    materialize(candidateRoot) {
      if (!updates) throw new ProjectWorkPublicationUncertainError();
      for (const update of updates) {
        if (
          update.operation === "create" &&
          (update.kind === "plan" || update.kind === "reference")
        )
          core.createRecord(candidateRoot, { project: candidateRoot, ...update });
        else applyProjectLedgerRecordUpdate(core, candidateRoot, update);
      }
      for (const view of ["dashboard", "handoff", "roadmap"] as const)
        core.render(candidateRoot, view, { write: true });
      core.writeIndex(candidateRoot);
    },
  });
  if (result.status === "applied")
    return appliedOutcome(attempt, updates ?? [], replayed);
  if (result.status === "uncertain")
    throw new ProjectWorkPublicationUncertainError();
  throw new ProjectWorkPublicationNotAppliedError();
}

async function preparedUpdates(
  input: PublicationInput,
): Promise<ProjectLedgerRecordUpdate[] | null> {
  const updates = await typedProjectWorkPreparation(input.prepareUpdates);
  if (updates === null) return null;
  if (updates.length === 0)
    throw new ProjectWorkAdapterError("project_work_publication_empty");
  return updates;
}

function capture(
  core: ProjectLedgerCore,
  scope: ResolvedProjectWorkScope,
  updates: ProjectLedgerRecordUpdate[],
) {
  return captureExactPublicationAttempt({
    core,
    projectRoot: scope.ledgerRoot,
    projectId: scope.ledgerProjectId,
    updates: [...updates, ...projectWorkPublicationProofUpdates(updates)],
  });
}

function exactScope(scope: ResolvedProjectWorkScope) {
  let exact: ReturnType<typeof resolveExactProjectLedgerScope>;
  try {
    exact = resolveExactProjectLedgerScope(scope.ledgerRoot);
  } catch {
    throw new ProjectWorkPublicationUncertainError();
  }
  if (
    exact.ledgerProjectId !== scope.ledgerProjectId ||
    exact.ledgerRoot !== scope.ledgerRoot
  )
    throw new ProjectWorkAdapterError("project_work_scope_mismatch");
  return exact;
}

function operationIdentity(identity: ProjectWorkOperationIdentity) {
  return { kind: identity.kind, id: identity.id };
}

function appliedOutcome(
  attempt: ProjectLedgerEffectAttempt,
  updates: ProjectLedgerRecordUpdate[],
  replayed: boolean,
): ProjectWorkPublicationOutcome {
  return {
    replayed,
    skipped: false,
    targets: attempt.targetPreconditions,
    preparedUpdates: updates,
  };
}

function skippedOutcome(): ProjectWorkPublicationOutcome {
  return { replayed: false, skipped: true, targets: [], preparedUpdates: [] };
}

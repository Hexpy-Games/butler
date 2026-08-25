import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  runRuntimeMemoryAttributionAsyncPhase,
  runRuntimeMemoryAttributionPhase,
  type RuntimeMemoryAttributionPort,
} from "../../../../operations/diagnostics/runtime-memory-attribution/index.ts";
import {
  admitProjectLedgerEffectOccurrence,
  appendProjectLedgerEffectAttempt,
  ProjectLedgerEffectConflictError,
  readProjectLedgerEffectOccurrence,
  type ProjectLedgerEffectAttempt,
  type ProjectLedgerEffectOccurrence,
} from "./external-effect-occurrence.ts";
import {
  applyProjectLedgerRecordUpdate,
  type ProjectLedgerRecordUpdate,
} from "./external-effect-record-update.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import {
  captureExactPublicationAttempt,
  hasUnsupportedLegacyProjectLedgerOccurrence,
  applyProjectLedgerPublicationAttempt,
  publicationPaths,
  reconcileProjectLedgerPublication,
  resolveExactProjectLedgerScope,
  type AppliedPublicationEvidence,
} from "./publication-recovery/index.ts";
import {
  loadProjectLedgerCore,
  type ProjectLedgerCore,
} from "./project-ledger-core.ts";
import type { ProjectLedgerHead } from "./runtime-types.ts";
export type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
export { ProjectLedgerEffectConflictError } from "./external-effect-occurrence.ts";
export type ProjectLedgerEffectResult = {
  schema: "butler.btcc-project-ledger-effect-result.v1";
  publicationId: string;
  effectKey: string;
  updatedRecords: Array<{ id: string; kind?: string }>;
  baseHead: PublicProjectLedgerHead;
  currentHead: PublicProjectLedgerHead;
  promotion: { status: "promoted" };
  observation: { status: "observed" };
};
type PublicProjectLedgerHead = Omit<ProjectLedgerHead, "projectRoot">;
export type ProjectLedgerEffectReconciliation =
  | { status: "applied"; result: ProjectLedgerEffectResult }
  | { status: "not_applied" }
  | { status: "uncertain"; message: string };
type EffectInput = {
  butlerData: string;
  projectRoot: string;
  effectKey: string;
  updates: ProjectLedgerRecordUpdate[];
  memoryAttribution?: RuntimeMemoryAttributionPort;
};
const SAFE_UNCERTAIN_MESSAGE =
  "The Project Ledger publication state could not be verified safely.";
export async function applyProjectLedgerRecordUpdates(
  input: EffectInput,
): Promise<ProjectLedgerEffectResult> {
  try {
    return await runRuntimeMemoryAttributionAsyncPhase({
      attribution: input.memoryAttribution,
      phase: "work_update",
      run: async () => {
        const outcome = await runEffect(input, "apply");
        if (outcome.status === "applied") return outcome.result;
        if (outcome.status === "not_applied")
          throw new ProjectLedgerEffectNotAppliedError();
        throw new ProjectLedgerEffectUncertainError();
      },
    });
  } catch (error) {
    if (
      error instanceof ProjectLedgerEffectConflictError ||
      error instanceof ProjectLedgerEffectNotAppliedError ||
      error instanceof ProjectLedgerEffectUncertainError
    )
      throw error;
    throw new ProjectLedgerEffectUncertainError();
  }
}
export async function reconcileProjectLedgerRecordUpdates(
  input: EffectInput,
): Promise<ProjectLedgerEffectReconciliation> {
  try {
    return await runEffect(input, "reconcile");
  } catch (error) {
    if (error instanceof ProjectLedgerEffectConflictError) throw error;
    return { status: "uncertain", message: SAFE_UNCERTAIN_MESSAGE };
  }
}
async function runEffect(
  input: EffectInput,
  mode: "apply" | "reconcile",
): Promise<ProjectLedgerEffectReconciliation> {
  if (input.updates.length === 0)
    throw new Error("project_ledger_effect_updates_empty");
  const core = await loadProjectLedgerCore();
  const scope = resolveExactProjectLedgerScope(input.projectRoot);
  if (
    hasUnsupportedLegacyProjectLedgerOccurrence({
      butlerData: input.butlerData,
      projectRoots: [input.projectRoot, scope.ledgerRoot],
      effectKey: input.effectKey,
    })
  ) {
    return { status: "uncertain", message: SAFE_UNCERTAIN_MESSAGE };
  }
  const requestSha256 = digest(stableJson(input.updates));
  const operationIdentity = {
    kind: "mutation_call" as const,
    id: input.effectKey,
  };
  let occurrence = readProjectLedgerEffectOccurrence({
    butlerData: input.butlerData,
    ledgerProjectId: scope.ledgerProjectId,
    ledgerRoot: scope.ledgerRoot,
    operationIdentity,
    requestSha256,
  });
  if (occurrence) {
    const attempt = occurrence.attempts.at(-1)!;
    const hadAttemptOutcome = existsSync(
      publicationPaths({
        butlerData: input.butlerData,
        publicationId: attempt.publicationId,
      }).receiptPath,
    );
    const recovered = await reconcileAttempt(input, core, occurrence, attempt);
    if (recovered.status === "applied") {
      return {
        status: "applied",
        result: await effectResult(
          input,
          recovered.evidence,
          occurrence.ledgerRoot,
        ),
      };
    }
    if (recovered.status === "uncertain") return recovered;
    if (recovered.status === "ready")
      return publish(input, core, occurrence, attempt);
    if (mode === "reconcile") return { status: "not_applied" };
    if (!hadAttemptOutcome) return { status: "not_applied" };
    occurrence = await admitNextAttempt(
      input,
      core,
      occurrence,
      scope.ledgerProjectId,
      requestSha256,
    );
    return publish(input, core, occurrence, occurrence.attempts.at(-1)!);
  }
  if (mode === "reconcile") return { status: "not_applied" };
  const snapshot = await exactSnapshot(input, core, scope.ledgerProjectId);
  occurrence = admitProjectLedgerEffectOccurrence({
    butlerData: input.butlerData,
    ledgerProjectId: scope.ledgerProjectId,
    ledgerRoot: scope.ledgerRoot,
    operationIdentity,
    requestSha256,
    expectedBase: snapshot.expectedBase,
    targetPreconditions: snapshot.targetPreconditions,
  });
  return publish(input, core, occurrence, occurrence.attempts[0]!);
}
async function reconcileAttempt(
  input: EffectInput,
  core: ProjectLedgerCore,
  occurrence: ProjectLedgerEffectOccurrence,
  attempt: ProjectLedgerEffectAttempt,
) {
  return reconcileProjectLedgerPublication({
    core,
    butlerData: input.butlerData,
    ledgerRoot: occurrence.ledgerRoot,
    occurrenceId: occurrence.occurrenceId,
    attempt,
    observeHead: observeProjectLedgerHead,
  });
}
async function publish(
  input: EffectInput,
  core: ProjectLedgerCore,
  occurrence: ProjectLedgerEffectOccurrence,
  attempt: ProjectLedgerEffectAttempt,
): Promise<ProjectLedgerEffectReconciliation> {
  const recovered = await applyProjectLedgerPublicationAttempt({
    core,
    butlerData: input.butlerData,
    ledgerRoot: occurrence.ledgerRoot,
    occurrenceId: occurrence.occurrenceId,
    attempt,
    observeHead: (root) => attributedHead(input, root),
    runPhase: (phase, run) => runRuntimeMemoryAttributionPhase({
      attribution: input.memoryAttribution,
      phase,
      run,
    }),
    materialize(candidateRoot) {
      runRuntimeMemoryAttributionPhase({
        attribution: input.memoryAttribution,
        phase: "materialize",
        run: () => materialize(input, core, candidateRoot),
      });
    },
  });
  if (recovered.status !== "applied") return recovered;
  return {
    status: "applied",
    result: await effectResult(input, recovered.evidence, occurrence.ledgerRoot),
  };
}
function materialize(
  input: EffectInput,
  core: ProjectLedgerCore,
  candidateRoot: string,
): void {
  for (const update of input.updates)
    applyProjectLedgerRecordUpdate(core, candidateRoot, update);
  for (const view of ["dashboard", "handoff", "roadmap"] as const) {
    runRuntimeMemoryAttributionPhase({
      attribution: input.memoryAttribution,
      phase: `render_${view}`,
      run: () => core.render(candidateRoot, view, { write: true }),
    });
  }
  runRuntimeMemoryAttributionPhase({
    attribution: input.memoryAttribution,
    phase: "write_index",
    run: () => core.writeIndex(candidateRoot),
  });
}
async function exactSnapshot(
  input: EffectInput,
  core: ProjectLedgerCore,
  projectId: string,
) {
  return runRuntimeMemoryAttributionAsyncPhase({
    attribution: input.memoryAttribution,
    phase: "observe_base",
    run: () =>
      captureExactPublicationAttempt({
        core,
        projectRoot: input.projectRoot,
        projectId,
        updates: input.updates,
      }),
  });
}
async function admitNextAttempt(
  input: EffectInput,
  core: ProjectLedgerCore,
  occurrence: ProjectLedgerEffectOccurrence,
  projectId: string,
  requestSha256: string,
): Promise<ProjectLedgerEffectOccurrence> {
  const snapshot = await exactSnapshot(input, core, projectId);
  return appendProjectLedgerEffectAttempt({
    butlerData: input.butlerData,
    ledgerProjectId: projectId,
    ledgerRoot: occurrence.ledgerRoot,
    operationIdentity: occurrence.operationIdentity,
    requestSha256,
    afterAttemptNumber: occurrence.attempts.at(-1)!.number,
    expectedBase: snapshot.expectedBase,
    targetPreconditions: snapshot.targetPreconditions,
  });
}

async function effectResult(
  input: EffectInput,
  evidence: AppliedPublicationEvidence,
  ledgerRoot: string,
): Promise<ProjectLedgerEffectResult> {
  const current = await runRuntimeMemoryAttributionAsyncPhase({
    attribution: input.memoryAttribution,
    phase: "observe_current_head",
    run: () => attributedHead(input, ledgerRoot),
  });
  return {
    schema: "butler.btcc-project-ledger-effect-result.v1",
    publicationId: evidence.publicationId,
    effectKey: input.effectKey,
    updatedRecords: input.updates.map(({ id, kind }) => ({
      id,
      ...(kind ? { kind } : {}),
    })),
    baseHead: publicHead(evidence.baseHead),
    currentHead: publicHead(current),
    promotion: { status: evidence.promotionStatus },
    observation: { status: evidence.observationStatus },
  };
}

function publicHead(head: ProjectLedgerHead): PublicProjectLedgerHead {
  const { projectRoot: _privatePath, ...safe } = head;
  return safe;
}

async function attributedHead(
  input: EffectInput,
  projectRoot: string,
): Promise<ProjectLedgerHead> {
  return runRuntimeMemoryAttributionAsyncPhase({
    attribution: input.memoryAttribution,
    phase: "source_head",
    run: () => observeProjectLedgerHead(projectRoot),
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sort(item)]),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class ProjectLedgerEffectNotAppliedError extends Error {
  readonly code = "project_ledger_effect_not_applied";
  constructor() {
    super("The Project Ledger publication was not applied.");
  }
}

class ProjectLedgerEffectUncertainError extends Error {
  readonly code = "project_ledger_effect_uncertain";
  constructor() {
    super(SAFE_UNCERTAIN_MESSAGE);
  }
}

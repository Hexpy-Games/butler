import type { PromptUsageReport } from "../../../integrations/providers/provider.ts";
import { consolidateCandidates } from "./consolidate-candidates.ts";
import type {
  BtccRetrospective,
  BtccRetrospectiveMetrics,
  BtccRetrospectiveStore,
  BtccTrajectory,
  GuidanceDecision,
  PhaseGuidanceCandidate,
  RetrospectiveModelRunner,
} from "./contracts.ts";
import { evaluateTrajectory } from "./evaluate-trajectory.ts";
import { defaultRetrospectiveModelRunner } from "./model.ts";
import { SqliteBtccRetrospectiveStore } from "./sqlite-retrospective-store.ts";
import { usageFromPromptUsageReports } from "../consolidation/usage.ts";

export async function runBtccRetrospective(input: {
  butlerData: string;
  dbPath: string;
  modelRunner?: RetrospectiveModelRunner;
  store?: BtccRetrospectiveStore;
  limit?: number;
  runId?: string;
}): Promise<BtccRetrospectiveMetrics> {
  const store = input.store ?? new SqliteBtccRetrospectiveStore(input.dbPath);
  const modelRunner = input.modelRunner ?? defaultRetrospectiveModelRunner;
  const usage: PromptUsageReport[] = [];
  const cacheScopePrefix = `cognition:${input.runId ?? "manual"}:btcc_retrospective`;
  let processed = 0;
  let failed = 0;
  let promoted = 0;
  try {
    const trajectories = store.loadPendingTrajectories(input.limit);
    for (const trajectory of trajectories) {
      try {
        const retrospective = await loadOrEvaluate({
          trajectory, store, modelRunner, butlerData: input.butlerData, usage, cacheScopePrefix,
        });
        const decisions = await loadOrConsolidate({
          trajectory, retrospective, store, modelRunner, butlerData: input.butlerData, usage, cacheScopePrefix,
        });
        promoted += publishAcceptedGuidance(trajectory, retrospective, decisions, store);
        store.markProcessed(trajectory.outboxId);
        processed += 1;
      } catch (error) {
        store.recordFailure(
          trajectory.outboxId,
          error instanceof Error ? error.message : String(error),
        );
        failed += 1;
      }
    }
    return {
      pending_count: trajectories.length,
      processed_count: processed,
      failed_count: failed,
      promoted_guidance_count: promoted,
      model_usage: usageFromPromptUsageReports(usage.map((report) => ({
        model: report.model ?? "unknown",
        usage: report,
      }))),
      raw_text_included: false,
    };
  } finally {
    if (!input.store) store.close();
  }
}

async function loadOrEvaluate(input: {
  trajectory: BtccTrajectory;
  store: BtccRetrospectiveStore;
  modelRunner: RetrospectiveModelRunner;
  butlerData: string;
  usage: PromptUsageReport[];
  cacheScopePrefix: string;
}): Promise<BtccRetrospective> {
  const stored = input.store.loadRetrospective(input.trajectory.sourceId);
  if (stored) return stored;
  const evaluated = await evaluateTrajectory(input);
  if (evaluated.model.usage) input.usage.push(evaluated.model.usage);
  input.store.saveRetrospective(evaluated.value);
  return evaluated.value;
}

async function loadOrConsolidate(input: {
  trajectory: BtccTrajectory;
  retrospective: BtccRetrospective;
  store: BtccRetrospectiveStore;
  modelRunner: RetrospectiveModelRunner;
  butlerData: string;
  usage: PromptUsageReport[];
  cacheScopePrefix: string;
}) {
  const stored = input.store.loadDecisions(input.trajectory.sourceId);
  if (stored) return stored.decisions;
  const acceptedGuidance = input.store.loadAcceptedGuidance(
    input.trajectory,
    input.retrospective.candidates.map(({ phase }) => phase),
  );
  const consolidated = await consolidateCandidates({ ...input, acceptedGuidance });
  if (consolidated.model?.usage) input.usage.push(consolidated.model.usage);
  input.store.saveDecisions(consolidated.value);
  return consolidated.value.decisions;
}

function publishAcceptedGuidance(
  trajectory: BtccTrajectory,
  retrospective: BtccRetrospective,
  decisions: GuidanceDecision[],
  store: BtccRetrospectiveStore,
): number {
  const candidates = new Map(
    retrospective.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  let published = 0;
  for (const decision of decisions) {
    if (!isAccepted(decision)) continue;
    const candidate = candidates.get(decision.candidateId);
    if (!candidate) throw new Error(`Guidance candidate disappeared: ${decision.candidateId}`);
    store.publishGuidance(acceptedGuidance(trajectory, candidate, decision));
    published += 1;
  }
  return published;
}

function isAccepted(decision: GuidanceDecision): boolean {
  return decision.disposition === "promote" ||
    decision.disposition === "merge" ||
    decision.disposition === "supersede";
}

function acceptedGuidance(
  trajectory: BtccTrajectory,
  candidate: PhaseGuidanceCandidate,
  decision: GuidanceDecision,
) {
  const scope = candidate.scopeKind === "project"
    ? trajectory.projectRef
      ? { kind: "project" as const, projectRef: trajectory.projectRef }
      : null
    : { kind: "user" as const, userRef: trajectory.userRef };
  if (!scope) throw new Error("Project guidance candidate requires a project-bound trajectory");
  return {
    guidanceId: decision.guidanceId,
    phase: candidate.phase,
    scope,
    guidance: candidate.guidance,
    appliesWhen: candidate.appliesWhen,
    doesNotApplyWhen: candidate.doesNotApplyWhen,
    sourceIds: [trajectory.sourceId],
  };
}

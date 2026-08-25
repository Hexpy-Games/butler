import type { DurableWorkView } from "../../../btcc/work/index.ts";
import { digest, stableJson } from "../../../btcc/identity/index.ts";
import type {
  ProjectWorkOperationIdentity,
  ResolvedProjectWorkScope,
} from "./project-work-contracts.ts";
import { projectWorkRecordId } from "./project-work-json.ts";
import { publishProjectWorkRecords } from "./project-work-publication.ts";
import { projectWorkReplayContext } from "./project-work-replay-context.ts";
import { requireCurrentProjectWork } from "./project-work-snapshot.ts";

type RawMutation = Record<string, unknown> & {
  turnId: string;
  sessionId: string;
  mutationCallId: string;
  projectRef?: string;
};

export async function probeProjectWorkServiceReplay(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  mutation: unknown;
}): Promise<DurableWorkView | null> {
  const mutation = replayMutation(input.mutation);
  if (!mutation) return null;
  const identity: ProjectWorkOperationIdentity = {
    kind: "mutation_call",
    id: mutation.raw.mutationCallId,
    mutationCallId: mutation.raw.mutationCallId,
    requestSha256: digest(
      stableJson({
        operation: mutation.operation,
        input: mutation.identityInput,
      }),
    ),
  };
  const outcome = await publishProjectWorkRecords({
    butlerData: input.butlerData,
    scope: input.scope,
    identity,
    prepareUpdates: () => Promise.resolve(null),
  });
  if (outcome.skipped) return null;
  const child = replayChildTarget(mutation.operation, mutation.raw.mutationCallId);
  const childTargets = outcome.targets.filter(
    (target) =>
      target.id === child.id &&
      target.kind === child.kind &&
      typeof target.parentId === "string",
  );
  if (childTargets.length !== 1)
    throw new Error("project_work_replay_target_missing");
  const workId = childTargets[0]!.parentId!;
  const workTargets = outcome.targets.filter(
    (target) =>
      target.id === workId &&
      target.kind === "work" &&
      target.parentId === null,
  );
  if (workTargets.length !== 1)
    throw new Error("project_work_replay_target_missing");
  const current = await requireCurrentProjectWork({
    butlerData: input.butlerData,
    scope: input.scope,
    workId,
  });
  return projectWorkReplayContext(
    current,
    mutation.operation,
    mutation.raw,
    identity,
  );
}

function replayChildTarget(operation: string, mutationCallId: string) {
  if (operation === "replace_plan")
    return { id: projectWorkRecordId("plan", mutationCallId), kind: "plan" };
  const kind = operation === "record_checkpoint" ? "checkpoint" : "review";
  return { id: projectWorkRecordId(kind, mutationCallId), kind: "reference" };
}

function replayMutation(value: unknown):
  | { operation: string; raw: RawMutation; identityInput: unknown }
  | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as RawMutation;
  if (
    typeof raw.mutationCallId !== "string" ||
    typeof raw.turnId !== "string" ||
    typeof raw.sessionId !== "string"
  )
    return null;
  const common = {
    turnId: raw.turnId,
    sessionId: raw.sessionId,
    projectRef: raw.projectRef ?? null,
    mutationCallId: raw.mutationCallId,
  };
  if (Array.isArray(raw.actions) && Array.isArray(raw.checks)) {
    const startNew = raw.startNew ?? false;
    return {
      operation: "replace_plan",
      raw,
      identityInput: {
        ...common,
        startNew,
        objective: raw.objective,
        governingRefs: raw.governingRefs ?? [],
        actions: raw.actions,
        checks: raw.checks,
      },
    };
  }
  if (typeof raw.subject === "string")
    return {
      operation: "record_review",
      raw,
      identityInput: {
        ...common,
        subject: raw.subject,
        verdict: raw.verdict,
        summary: raw.summary,
        corrections: raw.corrections,
        actionUpdates: raw.actionUpdates ?? [],
        correctionScope: raw.correctionScope ?? null,
      },
    };
  if (
    "actionUpdates" in raw ||
    "publicSummary" in raw ||
    "nextStep" in raw
  )
    return {
      operation: "record_checkpoint",
      raw,
      identityInput: {
        ...common,
        actionUpdates: raw.actionUpdates ?? [],
        publicSummary: raw.publicSummary ?? null,
        nextStep: raw.nextStep ?? null,
      },
    };
  return null;
}

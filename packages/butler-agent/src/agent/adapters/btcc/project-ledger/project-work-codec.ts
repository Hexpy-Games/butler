import type {
  DurableWorkActionProgress,
  DurableWorkToolResultRef,
  DurableWorkView,
  WorkStage,
} from "../../../btcc/work/index.ts";
import {
  validateOperationIdentity,
  stageValue,
} from "./project-work-child-codec.ts";
import type {
  ProjectWorkOperationIdentity,
  ResolvedProjectWorkScope,
} from "./project-work-contracts.ts";
import {
  boundedArray,
  digestValue,
  exactKeys,
  invalid,
  isoRequired,
  nonnegative,
  object,
  parseCanonical,
  positiveRevision,
  textRequired,
  textValue,
} from "./project-work-json.ts";
import {
  validateMaterialSnapshot,
  type ProjectWorkMaterialSnapshot,
} from "./project-work-material-snapshot.ts";

export const PROJECT_WORK_SPEC = "SPEC-BTCC-R3-WORK-LEDGER-SCOPE";

export type ProjectWorkManifest = {
  schema: "butler.btcc-project-work.v1";
  workId: string;
  sessionId: string;
  scope: { appProjectId: string; ledgerProjectId: string };
  origin: { turnId: string; messageId: string };
  objective: string;
  status: DurableWorkView["status"];
  sessionHead: boolean;
  currentStage?: WorkStage;
  allowedNextStages: WorkStage[];
  actionProgress: DurableWorkActionProgress[];
  currentPlanRevisionId?: string;
  latestCheckpointRevisionId?: string;
  latestPlanReviewRevisionId?: string;
  latestResultReviewRevisionId?: string;
  latestCompletionValidationRevisionId?: string;
  latestDispositionRevisionId?: string;
  resultRefs: DurableWorkToolResultRef[];
  bindingRefs: Array<{
    bindingRevisionId: string;
    turnId: string;
    revision: number;
  }>;
  planRevision: number;
  checkpointRevision: number;
  checkpointResultSequence: number;
  reviewRevision: number;
  dispositionRevision: number;
  resultSequence: number;
  materialFingerprint: string;
  materialSnapshot: ProjectWorkMaterialSnapshot;
  operationIdentity: ProjectWorkOperationIdentity;
  createdAt: string;
  updatedAt: string;
};

export function decodeManifest(
  body: string,
  expected: { workId: string; scope: ResolvedProjectWorkScope },
): ProjectWorkManifest {
  const value = parseCanonical(body);
  exactKeys(value, MANIFEST_KEYS, MANIFEST_OPTIONAL_KEYS);
  if (
    value.schema !== "butler.btcc-project-work.v1" ||
    value.workId !== expected.workId
  )
    invalid();
  const scope = object(value.scope);
  exactKeys(scope, ["appProjectId", "ledgerProjectId"]);
  if (
    scope.appProjectId !== expected.scope.appProjectId ||
    scope.ledgerProjectId !== expected.scope.ledgerProjectId
  )
    invalid();
  const manifest = value as ProjectWorkManifest;
  validateManifest(manifest);
  return manifest;
}

export function officialWorkStatus(status: DurableWorkView["status"]): string {
  if (status === "blocked") return "blocked";
  if (status === "completed") return "review";
  if (status === "abandoned") return "cancelled";
  return "in_progress";
}

function validateManifest(value: ProjectWorkManifest): void {
  textRequired(value.sessionId);
  textRequired(value.objective);
  isoRequired(value.createdAt);
  isoRequired(value.updatedAt);
  if (!["open", "blocked", "completed", "abandoned"].includes(value.status))
    invalid();
  if (typeof value.sessionHead !== "boolean") invalid();
  boundedArray(value.allowedNextStages).forEach(stageValue);
  boundedArray(value.actionProgress).forEach(validateProgress);
  boundedArray(value.resultRefs).forEach(validateResultRef);
  boundedArray(value.bindingRefs).forEach(validateBindingRef);
  for (const revision of [
    value.planRevision,
    value.checkpointRevision,
    value.checkpointResultSequence,
    value.reviewRevision,
    value.dispositionRevision,
    value.resultSequence,
  ])
    nonnegative(revision);
  if (
    value.resultSequence !== value.resultRefs.length ||
    value.checkpointResultSequence > value.resultSequence
  )
    invalid();
  digestValue(value.materialFingerprint);
  validateMaterialSnapshot(value.materialSnapshot);
  if (value.materialSnapshot.materialFingerprint !== value.materialFingerprint)
    invalid();
  validateOperationIdentity(value.operationIdentity);
  const origin = object(value.origin);
  exactKeys(origin, ["turnId", "messageId"]);
  textRequired(origin.turnId);
  textRequired(origin.messageId);
  if (value.currentStage !== undefined) stageValue(value.currentStage);
  for (const pointer of [
    value.currentPlanRevisionId,
    value.latestCheckpointRevisionId,
    value.latestPlanReviewRevisionId,
    value.latestResultReviewRevisionId,
    value.latestCompletionValidationRevisionId,
    value.latestDispositionRevisionId,
  ]) {
    if (pointer !== undefined) textRequired(pointer);
  }
  if (Boolean(value.currentPlanRevisionId) !== value.planRevision > 0)
    invalid();
  if (
    Boolean(value.latestCheckpointRevisionId) !==
    value.checkpointRevision > 0
  )
    invalid();
  if (
    Boolean(value.latestDispositionRevisionId) !==
    value.dispositionRevision > 0
  )
    invalid();
  if (
    Boolean(
      value.latestPlanReviewRevisionId ||
        value.latestResultReviewRevisionId ||
        value.latestCompletionValidationRevisionId,
    ) !==
    value.reviewRevision > 0
  )
    invalid();
}

function validateProgress(value: unknown): void {
  const item = object(value);
  exactKeys(item, ["actionKey", "status"], ["note"]);
  textRequired(item.actionKey);
  if (
    !["pending", "active", "done", "blocked", "skipped"].includes(
      String(item.status),
    )
  )
    invalid();
  if (item.note !== undefined) textValue(item.note);
}

function validateResultRef(value: unknown): void {
  const item = object(value);
  exactKeys(
    item,
    [
      "resultRef",
      "toolCallId",
      "toolName",
      "status",
      "originTurnId",
      "attachedAt",
    ],
    ["resultSha256", "errorCode"],
  );
  textRequired(item.resultRef);
  textRequired(item.toolCallId);
  textRequired(item.toolName);
  if (item.status !== "completed" || item.errorCode !== undefined) invalid();
  digestValue(item.resultSha256);
  textRequired(item.originTurnId);
  isoRequired(item.attachedAt);
}

function validateBindingRef(value: unknown): void {
  const item = object(value);
  exactKeys(item, ["bindingRevisionId", "turnId", "revision"]);
  textRequired(item.bindingRevisionId);
  textRequired(item.turnId);
  positiveRevision(item.revision);
}

const MANIFEST_KEYS = [
  "schema",
  "workId",
  "sessionId",
  "scope",
  "origin",
  "objective",
  "status",
  "sessionHead",
  "allowedNextStages",
  "actionProgress",
  "resultRefs",
  "bindingRefs",
  "planRevision",
  "checkpointRevision",
  "checkpointResultSequence",
  "reviewRevision",
  "dispositionRevision",
  "resultSequence",
  "materialFingerprint",
  "materialSnapshot",
  "operationIdentity",
  "createdAt",
  "updatedAt",
];
const MANIFEST_OPTIONAL_KEYS = [
  "currentStage",
  "currentPlanRevisionId",
  "latestCheckpointRevisionId",
  "latestPlanReviewRevisionId",
  "latestResultReviewRevisionId",
  "latestCompletionValidationRevisionId",
  "latestDispositionRevisionId",
];

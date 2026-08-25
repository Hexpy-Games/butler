import type {
  DurableWorkCheckpoint,
  DurableWorkDisposition,
  DurableWorkPlan,
  DurableWorkReview,
  DurableWorkToolResultRef,
} from "../../../btcc/work/index.ts";
import type { ProjectWorkOperationIdentity } from "./project-work-contracts.ts";
import { validateChild } from "./project-work-child-validation.ts";
export { stageValue } from "./project-work-child-validation.ts";
import {
  validateMaterialSnapshot,
  type ProjectWorkMaterialSnapshot,
} from "./project-work-material-snapshot.ts";
import {
  canonicalJson,
  digestValue,
  exactKeys,
  invalid,
  object,
  parseCanonical,
  requestDigest,
  textRequired,
} from "./project-work-json.ts";

export type ProjectWorkChild =
  | {
      schema: "butler.btcc-project-work-plan.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      plan: DurableWorkPlan;
    }
  | {
      schema: "butler.btcc-project-work-checkpoint.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      checkpointIdentity: string;
      checkpoint: DurableWorkCheckpoint;
      resultWindow: { fromSequence: number; toSequence: number };
    }
  | {
      schema: "butler.btcc-project-work-review.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      review: DurableWorkReview;
      boundResultSequence: number;
    }
  | {
      schema: "butler.btcc-project-work-disposition.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      disposition: DurableWorkDisposition;
      materialSnapshot: ProjectWorkMaterialSnapshot;
    }
  | {
      schema: "butler.btcc-project-work-result-reference.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      result: DurableWorkToolResultRef & { sequence: number };
    }
  | {
      schema: "butler.btcc-project-work-binding.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      binding: {
        bindingRevisionId: string;
        turnId: string;
        sessionId: string;
        revision: number;
        boundAt: string;
      };
    }
  | {
      schema: "butler.btcc-project-work-closeout-diagnostic.v1";
      workId: string;
      operationIdentity: ProjectWorkOperationIdentity;
      diagnostic: {
        diagnosticId: string;
        code: "closeout_missing";
        turnId: string;
        createdAt: string;
      };
    };

export function decodeChild<T extends ProjectWorkChild["schema"]>(
  body: string,
  expected: { schema: T; workId: string; recordId: string },
): Extract<ProjectWorkChild, { schema: T }> {
  const value = parseCanonical(body);
  const key = childKey(expected.schema);
  const wrapperKeys = expected.schema.endsWith("-checkpoint.v1")
    ? ["checkpointIdentity", "resultWindow"]
    : expected.schema.endsWith("-review.v1")
      ? ["boundResultSequence"]
      : [];
  exactKeys(value, [
    "schema",
    "workId",
    "operationIdentity",
    "recordSha256",
    key,
    ...wrapperKeys,
    ...(expected.schema === "butler.btcc-project-work-disposition.v1"
      ? ["materialSnapshot"]
      : []),
  ]);
  digestValue(value.recordSha256);
  const { recordSha256, ...semantic } = value;
  if (recordSha256 !== requestDigest(semantic)) invalid();
  if (value.schema !== expected.schema || value.workId !== expected.workId)
    invalid();
  validateOperationIdentity(value.operationIdentity);
  const child = object(value[key]);
  if (child[CHILD_ID_KEYS[expected.schema]] !== expected.recordId) invalid();
  validateChild(expected.schema, child);
  if (expected.schema === "butler.btcc-project-work-checkpoint.v1") {
    textRequired(value.checkpointIdentity);
    const window = object(value.resultWindow);
    exactKeys(window, ["fromSequence", "toSequence"]);
    if (
      !Number.isSafeInteger(window.fromSequence) ||
      !Number.isSafeInteger(window.toSequence) ||
      Number(window.fromSequence) < 0 ||
      Number(window.toSequence) < Number(window.fromSequence)
    )
      invalid();
  }
  if (expected.schema === "butler.btcc-project-work-review.v1") {
    if (
      !Number.isSafeInteger(value.boundResultSequence) ||
      Number(value.boundResultSequence) < 0
    )
      invalid();
  }
  if (expected.schema === "butler.btcc-project-work-disposition.v1") {
    validateMaterialSnapshot(value.materialSnapshot);
  }
  return semantic as Extract<ProjectWorkChild, { schema: T }>;
}

export function canonicalProjectWorkChildBody(
  child: ProjectWorkChild,
): string {
  return canonicalJson({
    ...child,
    recordSha256: requestDigest(child),
  });
}

export function validateOperationIdentity(
  value: unknown,
): asserts value is ProjectWorkOperationIdentity {
  const item = object(value);
  exactKeys(item, ["kind", "id", "requestSha256"], ["mutationCallId"]);
  if (
    ![
      "mutation_call",
      "binding_revision",
      "closeout_diagnostic",
      "abandonment",
    ].includes(String(item.kind))
  )
    invalid();
  textRequired(item.id);
  digestValue(item.requestSha256);
  if (item.kind === "mutation_call") {
    if (item.mutationCallId !== item.id) invalid();
  } else if (item.mutationCallId !== undefined) invalid();
}

function childKey(schema: ProjectWorkChild["schema"]): string {
  if (schema.endsWith("-plan.v1")) return "plan";
  if (schema.endsWith("-checkpoint.v1")) return "checkpoint";
  if (schema.endsWith("-review.v1")) return "review";
  if (schema.endsWith("-disposition.v1")) return "disposition";
  if (schema.endsWith("-result-reference.v1")) return "result";
  if (schema.endsWith("-binding.v1")) return "binding";
  return "diagnostic";
}
const CHILD_ID_KEYS: Record<ProjectWorkChild["schema"], string> = {
  "butler.btcc-project-work-plan.v1": "planRevisionId",
  "butler.btcc-project-work-checkpoint.v1": "checkpointRevisionId",
  "butler.btcc-project-work-review.v1": "reviewRevisionId",
  "butler.btcc-project-work-disposition.v1": "dispositionRevisionId",
  "butler.btcc-project-work-result-reference.v1": "resultRef",
  "butler.btcc-project-work-binding.v1": "bindingRevisionId",
  "butler.btcc-project-work-closeout-diagnostic.v1": "diagnosticId",
};

import {
  arraySchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
} from "../core/index.ts";
import { PLANNING_REVIEW_DIMENSIONS } from "./review-subjects.ts";

const findingFields = {
  rootCauseKey: textSchema(),
  dimension: enumSchema(...PLANNING_REVIEW_DIMENSIONS),
  message: textSchema(),
  priority: enumSchema("P0", "P1", "P2"),
};

export const planDraftReviewSubmissionSchema = objectSchema({
  kind: literalSchema("planning_review"),
  verdict: literalSchema("revision_required"),
  findings: arraySchema(variantsSchema(
    objectSchema({
      ...findingFields,
      recommendedDisposition: literalSchema("required_now"),
      findingOrigin: literalSchema("initial_review"),
    }),
    objectSchema({
      ...findingFields,
      recommendedDisposition: literalSchema("backlog"),
      findingOrigin: literalSchema("backlog_candidate"),
    }),
  )),
});

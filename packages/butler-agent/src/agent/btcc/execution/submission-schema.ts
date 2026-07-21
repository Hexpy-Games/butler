import {
  arraySchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
} from "../core/index.ts";

export const taskExecutionSubmissionSchema = objectSchema({
  kind: literalSchema("result_candidate"),
  resultSummary: textSchema(),
  observedStates: arraySchema(objectSchema({
    targetScopeRef: textSchema(),
    state: enumSchema("present", "absent"),
    description: textSchema(),
  })),
});

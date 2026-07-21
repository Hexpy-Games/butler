import { literalSchema, objectSchema, textSchema } from "../core/index.ts";

export const taskExecutionSubmissionSchema = objectSchema({
  kind: literalSchema("result_candidate"),
  resultSummary: textSchema(),
});

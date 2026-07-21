import {
  literalSchema,
  objectSchema,
  textSchema,
} from "../core/index.ts";

export const reportingSubmissionSchema = objectSchema({
  kind: literalSchema("prepared_report"),
  content: textSchema(),
});

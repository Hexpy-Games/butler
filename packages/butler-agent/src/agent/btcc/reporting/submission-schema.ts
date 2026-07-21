import {
  contentRefSchema,
  literalSchema,
  objectSchema,
  textSchema,
} from "../core/index.ts";

export const reportingSubmissionSchema = objectSchema({
  kind: literalSchema("prepared_report"),
  finalDossierRef: contentRefSchema(),
  guardVerdict: literalSchema("accepted"),
  content: textSchema(),
});

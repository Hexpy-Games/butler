import {
  arraySchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
} from "../core/index.ts";

const assessmentFields = {
  goalFieldVerdicts: arraySchema(objectSchema({
    verdict: enumSchema("fulfilled", "deferred", "not_fulfilled"),
  }), { minItems: 1 }),
  taskCompatibility: objectSchema({
    verdict: enumSchema("compatible", "deferred", "not_compatible"),
  }),
  semanticFidelity: enumSchema("faithful", "drift_detected"),
};

export const consolidationSubmissionSchema = variantsSchema(
  objectSchema({
    kind: literalSchema("final_dossier"),
    ...assessmentFields,
    goalCoverage: literalSchema("fulfilled"),
    summary: textSchema(),
  }),
  objectSchema({
    kind: literalSchema("final_dossier"),
    goalCoverage: literalSchema("deferred"),
    semanticFidelity: literalSchema("faithful"),
    summary: textSchema(),
  }),
  objectSchema({
    kind: literalSchema("promotion_authorization"),
    ...assessmentFields,
    goalCoverage: literalSchema("fulfilled"),
  }),
  objectSchema({
    kind: literalSchema("consolidation_repair"),
    ...assessmentFields,
    findings: arraySchema(textSchema(), { minItems: 1 }),
    affectedTaskIds: arraySchema(textSchema(), { minItems: 1 }),
  }),
);

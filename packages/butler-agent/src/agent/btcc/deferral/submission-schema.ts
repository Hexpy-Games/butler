import {
  arraySchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
  type SubmissionSchema,
} from "../core/index.ts";

const readiness = variantsSchema(
  objectSchema({
    kind: literalSchema("user_authority"),
    requiredAuthorityScopeRefs: arraySchema(textSchema(), { minItems: 1 }),
  }),
  objectSchema({
    kind: literalSchema("external_readiness"),
    observationScopeRefs: arraySchema(textSchema(), { minItems: 1 }),
  }),
  objectSchema({
    kind: literalSchema("scheduled_time"),
    notBefore: textSchema(),
  }),
);

export const managedDeferralSubmissionSchema = objectSchema({
  kind: literalSchema("managed_deferral"),
  reason: textSchema(),
  readiness,
});

export const promotionDeferralSubmissionSchema = objectSchema({
  kind: literalSchema("promotion_deferral"),
  reason: textSchema(),
  readiness,
});

export function withManagedDeferralSchema(schema: SubmissionSchema): SubmissionSchema {
  return variantsSchema(schema, managedDeferralSubmissionSchema);
}

export function withTaskExecutionDeferralSchema(schema: SubmissionSchema): SubmissionSchema {
  return variantsSchema(schema, managedDeferralSubmissionSchema, promotionDeferralSubmissionSchema);
}

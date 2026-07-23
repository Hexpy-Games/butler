export type SubmissionSchema = Record<string, unknown>;

export const textSchema = (): SubmissionSchema => ({ type: "string", minLength: 1 });
export const integerSchema = (): SubmissionSchema => ({ type: "integer" });
export const literalSchema = (value: string): SubmissionSchema => ({
  type: "string",
  const: value,
});
export const enumSchema = (...values: string[]): SubmissionSchema => ({
  type: "string",
  enum: values,
});
export const arraySchema = (
  items: SubmissionSchema,
  options: { minItems?: number; maxItems?: number } = {},
): SubmissionSchema => ({ type: "array", items, ...options });
export const objectSchema = (
  properties: Record<string, SubmissionSchema>,
): SubmissionSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const variantsSchema = (...variants: SubmissionSchema[]): SubmissionSchema => ({
  anyOf: variants,
});
export const contentRefSchema = (): SubmissionSchema => objectSchema({
  id: textSchema(),
  sha256: textSchema(),
});

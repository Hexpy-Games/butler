export type SchemaValidationResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      path: string;
      reason: SchemaViolationReason;
    };

export type SchemaViolationReason =
  | "missing_required"
  | "unexpected_property"
  | "constant_mismatch"
  | "enum_mismatch"
  | "variant_mismatch"
  | "type_mismatch"
  | "minimum_items"
  | "maximum_items"
  | "minimum_value"
  | "maximum_value"
  | "minimum_length"
  | "maximum_length";

export interface ToolCallArgumentsValidation {
  arguments: Record<string, unknown>;
  rawArguments: string;
  error: string | null;
}

export function validateToolCallArguments(input: {
  toolName: string;
  rawArguments: unknown;
  schema?: unknown;
}): ToolCallArgumentsValidation {
  const rawArguments = toolArgumentsText(input.rawArguments);
  let parsed: unknown = input.rawArguments;
  if (typeof input.rawArguments === "string") {
    try {
      parsed = JSON.parse(input.rawArguments);
    } catch {
      return {
        arguments: {},
        rawArguments,
        error: `Tool ${input.toolName} received malformed JSON arguments`,
      };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      arguments: {},
      rawArguments,
      error: `Tool ${input.toolName} arguments must be a JSON object`,
    };
  }

  const args = parsed as Record<string, unknown>;
  const validation = validateJsonObjectSchema(args, input.schema);
  if (validation.ok) return { arguments: args, rawArguments, error: null };
  const argumentPath = validation.path.replace(/^\$\.?/u, "");
  if (validation.reason === "missing_required") {
    return {
      arguments: args,
      rawArguments,
      error: `Tool ${input.toolName} requires argument: ${argumentPath}`,
    };
  }
  if (validation.reason === "unexpected_property") {
    const unexpected = validation.message.replace(/^Unexpected arguments?:\s*/u, "");
    return {
      arguments: args,
      rawArguments,
      error: `Tool ${input.toolName} received unsupported argument(s): ${unexpected}`,
    };
  }
  return {
    arguments: args,
    rawArguments,
    error: `Tool ${input.toolName} received invalid arguments: ${validation.message}`,
  };
}

export function validateJsonObjectSchema(
  value: Record<string, unknown>,
  schema: unknown,
): SchemaValidationResult {
  const record = objectRecord(schema);
  if (!record) return { ok: true };
  return validateJsonValue(value, record, "$");
}

function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
): SchemaValidationResult {
  const required = stringArray(schema.required);
  for (const key of required) {
    if (!(key in value)) {
      return {
        ok: false,
        message: `Missing required argument: ${key}`,
        path: `${path}.${key}`,
        reason: "missing_required",
      };
    }
  }
  const properties = objectRecord(schema.properties);
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const result = validateJsonValue(value[key], propertySchema, `${path}.${key}`);
      if (!result.ok) return result;
    }
  }
  const additional = schema.additionalProperties;
  if (additional === false) {
    const unexpected = Object.keys(value).filter((key) =>
      !properties || !(key in properties),
    );
    if (unexpected.length > 0) {
      return {
        ok: false,
        message: unexpected.length === 1
          ? `Unexpected argument: ${unexpected[0]}`
          : `Unexpected arguments: ${unexpected.join(", ")}`,
        path: unexpected.length === 1 ? `${path}.${unexpected[0]}` : path,
        reason: "unexpected_property",
      };
    }
  } else if (objectRecord(additional)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (properties && key in properties) continue;
      const result = validateJsonValue(nestedValue, additional, `${path}.${key}`);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function toolArgumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function validateJsonValue(value: unknown, schema: unknown, path: string): SchemaValidationResult {
  const record = objectRecord(schema);
  if (!record) return { ok: true };
  if ("const" in record && value !== record.const) {
    return {
      ok: false,
      message: `Expected constant value at ${path}`,
      path,
      reason: "constant_mismatch",
    };
  }
  const enumValues = Array.isArray(record.enum) ? record.enum : null;
  if (enumValues && !enumValues.includes(value)) {
    return {
      ok: false,
      message: `Invalid enum value at ${path}`,
      path,
      reason: "enum_mismatch",
    };
  }
  const oneOf = Array.isArray(record.oneOf) ? record.oneOf : null;
  if (oneOf) {
    const results = oneOf.map((variant) => validateJsonValue(value, variant, path));
    const matches = results.filter((result) => result.ok);
    if (matches.length !== 1) {
      const firstFailure = matchingDiscriminatorFailure(value, oneOf, results) ??
        results.find((result) => !result.ok);
      return {
        ok: false,
        message: matches.length === 0 && firstFailure && !firstFailure.ok
          ? `No schema variant matched: ${firstFailure.message}`
          : `Expected exactly one schema variant at ${path}`,
        path: matches.length === 0 && firstFailure && !firstFailure.ok ? firstFailure.path : path,
        reason: matches.length === 0 && firstFailure && !firstFailure.ok
          ? firstFailure.reason
          : "variant_mismatch",
      };
    }
  }
  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : null;
  if (anyOf) {
    const results = anyOf.map((variant) => validateJsonValue(value, variant, path));
    if (!results.some((result) => result.ok)) {
      const firstFailure = matchingDiscriminatorFailure(value, anyOf, results) ??
        results.find((result) => !result.ok);
      return {
        ok: false,
        message: firstFailure && !firstFailure.ok
          ? `No schema variant matched: ${firstFailure.message}`
          : `No schema variant matched at ${path}`,
        path: firstFailure && !firstFailure.ok ? firstFailure.path : path,
        reason: firstFailure && !firstFailure.ok
          ? firstFailure.reason
          : "variant_mismatch",
      };
    }
  }
  const types = schemaTypes(record.type);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return {
      ok: false,
      message: `Expected ${types.join(" or ")} at ${path}`,
      path,
      reason: "type_mismatch",
    };
  }
  if (Array.isArray(value)) return validateArray(value, record, path);
  if (value && typeof value === "object" && !Array.isArray(value)) return validateObject(value as Record<string, unknown>, record, path);
  if (typeof value === "number") return validateNumber(value, record, path);
  if (typeof value === "string") return validateString(value, record, path);
  return { ok: true };
}

function matchingDiscriminatorFailure(
  value: unknown,
  variants: unknown[],
  results: SchemaValidationResult[],
): SchemaValidationResult | undefined {
  const input = objectRecord(value);
  if (!input) return undefined;
  let candidates = variants.map((_, index) => index);
  let discriminated = false;
  for (const key of sharedConstantProperties(variants)) {
    if (!(key in input)) continue;
    const matching = candidates.filter((index) =>
      constantPropertyValue(variants[index], key) === input[key],
    );
    if (matching.length === 0) return undefined;
    candidates = matching;
    discriminated = true;
  }
  if (!discriminated) return undefined;
  return candidates.map((index) => results[index]).find((result) => result && !result.ok);
}

function sharedConstantProperties(variants: unknown[]): string[] {
  if (variants.length < 2) return [];
  const firstProperties = objectRecord(objectRecord(variants[0])?.properties);
  if (!firstProperties) return [];
  return Object.keys(firstProperties).filter((key) =>
    variants.every((variant) => constantPropertyValue(variant, key) !== undefined),
  );
}

function constantPropertyValue(variant: unknown, key: string): unknown {
  const properties = objectRecord(objectRecord(variant)?.properties);
  const property = properties ? objectRecord(properties[key]) : null;
  return property && "const" in property ? property.const : undefined;
}

function validateArray(value: unknown[], schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return {
      ok: false,
      message: `Expected at least ${schema.minItems} items at ${path}`,
      path,
      reason: "minimum_items",
    };
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return {
      ok: false,
      message: `Expected at most ${schema.maxItems} items at ${path}`,
      path,
      reason: "maximum_items",
    };
  }
  const itemSchema = schema.items;
  if (!itemSchema) return { ok: true };
  for (let index = 0; index < value.length; index += 1) {
    const result = validateJsonValue(value[index], itemSchema, `${path}[${index}]`);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function validateNumber(value: number, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return {
      ok: false,
      message: `Expected value >= ${schema.minimum} at ${path}`,
      path,
      reason: "minimum_value",
    };
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return {
      ok: false,
      message: `Expected value <= ${schema.maximum} at ${path}`,
      path,
      reason: "maximum_value",
    };
  }
  return { ok: true };
}

function validateString(value: string, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    return {
      ok: false,
      message: `Expected string length >= ${schema.minLength} at ${path}`,
      path,
      reason: "minimum_length",
    };
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return {
      ok: false,
      message: `Expected string length <= ${schema.maxLength} at ${path}`,
      path,
      reason: "maximum_length",
    };
  }
  return { ok: true };
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "null") return value === null;
  return typeof value === type;
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

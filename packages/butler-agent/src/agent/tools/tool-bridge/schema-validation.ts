export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; message: string; path: string };

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
    if (!(key in value)) return { ok: false, message: `Missing required argument: ${key}`, path: `${path}.${key}` };
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
    for (const key of Object.keys(value)) {
      if (!properties || !(key in properties)) {
        return { ok: false, message: `Unexpected argument: ${key}`, path: `${path}.${key}` };
      }
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

function validateJsonValue(value: unknown, schema: unknown, path: string): SchemaValidationResult {
  const record = objectRecord(schema);
  if (!record) return { ok: true };
  if ("const" in record && value !== record.const) {
    return { ok: false, message: `Expected constant value at ${path}`, path };
  }
  const enumValues = Array.isArray(record.enum) ? record.enum : null;
  if (enumValues && !enumValues.includes(value)) return { ok: false, message: `Invalid enum value at ${path}`, path };
  const oneOf = Array.isArray(record.oneOf) ? record.oneOf : null;
  if (oneOf) {
    const results = oneOf.map((variant) => validateJsonValue(value, variant, path));
    const matches = results.filter((result) => result.ok);
    if (matches.length !== 1) {
      const firstFailure = results.find((result) => !result.ok);
      return {
        ok: false,
        message: matches.length === 0 && firstFailure && !firstFailure.ok
          ? `No schema variant matched: ${firstFailure.message}`
          : `Expected exactly one schema variant at ${path}`,
        path: matches.length === 0 && firstFailure && !firstFailure.ok ? firstFailure.path : path,
      };
    }
  }
  const types = schemaTypes(record.type);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return { ok: false, message: `Expected ${types.join(" or ")} at ${path}`, path };
  }
  if (Array.isArray(value)) return validateArray(value, record, path);
  if (value && typeof value === "object" && !Array.isArray(value)) return validateObject(value as Record<string, unknown>, record, path);
  if (typeof value === "number") return validateNumber(value, record, path);
  if (typeof value === "string") return validateString(value, record, path);
  return { ok: true };
}

function validateArray(value: unknown[], schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return { ok: false, message: `Expected at least ${schema.minItems} items at ${path}`, path };
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return { ok: false, message: `Expected at most ${schema.maxItems} items at ${path}`, path };
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
    return { ok: false, message: `Expected value >= ${schema.minimum} at ${path}`, path };
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return { ok: false, message: `Expected value <= ${schema.maximum} at ${path}`, path };
  }
  return { ok: true };
}

function validateString(value: string, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    return { ok: false, message: `Expected string length >= ${schema.minLength} at ${path}`, path };
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return { ok: false, message: `Expected string length <= ${schema.maxLength} at ${path}`, path };
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

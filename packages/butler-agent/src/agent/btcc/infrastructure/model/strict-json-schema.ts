export function normalizeStrictTransportSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeNode(schema) as Record<string, unknown>;
}

export function restoreTransportOmissions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreTransportOmissions);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, restoreTransportOmissions(item)]),
  );
}

function normalizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNode);
  if (!isRecord(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeNode(item)]),
  );
  if (isPureSchemaCombinator(value)) {
    const {
      type: _type,
      properties: _properties,
      required: _required,
      additionalProperties: _additionalProperties,
      ...combinator
    } = normalized;
    return combinator;
  }
  if (value.type !== "object") return normalized;

  const required = new Set(
    Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const declaredProperties = isRecord(value.properties) ? value.properties : {};
  const properties = Object.fromEntries(
    Object.entries(declaredProperties).map(([key, property]) => [
      key,
      required.has(key) ? normalizeNode(property) : allowTransportNull(normalizeNode(property)),
    ]),
  );
  return {
    ...normalized,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function isPureSchemaCombinator(value: Record<string, unknown>): boolean {
  const hasVariants = Array.isArray(value.anyOf) || Array.isArray(value.oneOf);
  return hasVariants && !isRecord(value.properties);
}

function allowTransportNull(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  if (schema.type === "null") return schema;
  if (Array.isArray(schema.anyOf) && schema.anyOf.some(isNullSchema)) return schema;
  return { anyOf: [schema, { type: "null" }] };
}

function isNullSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

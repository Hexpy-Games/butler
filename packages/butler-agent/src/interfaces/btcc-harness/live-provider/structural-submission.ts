export function structuralSubmissionSchema(template: unknown): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["submission"],
    properties: { submission: structuralValueSchema(template) },
  };
}

export function assertStructuralSubmission(template: unknown, actual: unknown): void {
  assertStructuralValue(template, actual, "submission");
}

export function bindStructuralSubmission(template: unknown, authored: unknown): unknown {
  return bindStructuralValue(template, authored, "submission");
}

function structuralValueSchema(
  value: unknown,
  key?: string,
  insideArray = false,
): Record<string, unknown> {
  if (typeof value === "string") {
    return isStructuralEnum(key) || (isIdentityString(key) && !insideArray)
      ? { type: "string", enum: [value] }
      : { type: "string", minLength: 1 };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return insideArray
      ? value === null ? { type: "null" } : { type: typeof value }
      : { enum: [value] };
  }
  if (Array.isArray(value)) {
    const flexible = isSemanticList(key);
    return {
      type: "array",
      items: identityArraySchema(value, key)
        ?? (value.length === 0 ? { type: "string" } : structuralValueSchema(value[0], key, true)),
      minItems: flexible ? 0 : value.length,
      maxItems: flexible ? 12 : value.length,
    };
  }
  if (typeof value === "object" && value) {
    const entries = Object.entries(value);
    return {
      type: "object",
      additionalProperties: false,
      required: entries.map(([entryKey]) => entryKey),
      properties: Object.fromEntries(entries.map(([entryKey, entryValue]) => [
        entryKey,
        structuralValueSchema(entryValue, entryKey, insideArray),
      ])),
    };
  }
  throw new Error(`Unsupported live BTCC template value at ${key ?? "submission"}`);
}

function assertStructuralValue(template: unknown, actual: unknown, path: string): void {
  if (typeof template === "string") {
    assertStructuralString(template, actual, path);
    return;
  }
  if (Array.isArray(template)) {
    const key = path.split(".").at(-1)?.replace(/\[\d+\]$/u, "");
    if (!Array.isArray(actual) || (!isSemanticList(key) && actual.length !== template.length)) {
      throw new Error(`${path} must retain exactly ${template.length} entries`);
    }
    if (!isSemanticList(key)) {
      template.forEach((item, index) => {
        assertStructuralValue(item, actual[index], `${path}[${index}]`);
      });
    } else if (!actual.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`${path} must contain only non-empty semantic strings`);
    }
    return;
  }
  if (template && typeof template === "object") {
    assertStructuralObject(template as Record<string, unknown>, actual, path);
    return;
  }
  if (actual !== template) throw new Error(`${path} must retain its structural value`);
}

function bindStructuralValue(
  template: unknown,
  authored: unknown,
  path: string,
): unknown {
  const key = path.split(".").at(-1)?.replace(/\[\d+\]$/u, "");
  if (typeof template === "string") {
    if (isStructuralEnum(key) || isIdentityString(key)) return template;
    if (typeof authored !== "string" || authored.length === 0) {
      throw new Error(`${path} requires model-authored semantic text`);
    }
    return authored;
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(authored)) throw new Error(`${path} must remain an array`);
    if (isSemanticList(key)) return authored;
    if (isIdentityString(key)) return template;
    if (authored.length !== template.length) {
      throw new Error(`${path} must retain exactly ${template.length} structural entries`);
    }
    return template.map((item, index) =>
      bindStructuralValue(item, authored[index], `${path}[${index}]`));
  }
  if (template && typeof template === "object") {
    if (!authored || typeof authored !== "object" || Array.isArray(authored)) {
      throw new Error(`${path} must remain an object`);
    }
    return Object.fromEntries(Object.entries(template).map(([field, value]) => [
      field,
      bindStructuralValue(
        value,
        (authored as Record<string, unknown>)[field],
        `${path}.${field}`,
      ),
    ]));
  }
  return template;
}

function assertStructuralString(template: string, actual: unknown, path: string): void {
  if (typeof actual !== "string" || actual.length === 0) {
    throw new Error(`${path} must remain a non-empty string`);
  }
  const key = path.split(".").at(-1)?.replace(/\[\d+\]$/u, "");
  if ((isStructuralEnum(key) || isIdentityString(key)) && actual !== template) {
    throw new Error(`${path} must remain exactly ${JSON.stringify(template)}`);
  }
}

function assertStructuralObject(
  template: Record<string, unknown>,
  actual: unknown,
  path: string,
): void {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`${path} must remain an object`);
  }
  const expectedKeys = Object.keys(template);
  const actualKeys = Object.keys(actual);
  if (JSON.stringify(actualKeys.sort()) !== JSON.stringify(expectedKeys.slice().sort())) {
    throw new Error(`${path} must retain the exact structural fields`);
  }
  for (const key of expectedKeys) {
    assertStructuralValue(template[key], (actual as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

function isStructuralEnum(key: string | undefined): boolean {
  if (!key) return false;
  return key === "kind" || key === "verdict" || key === "decision" ||
    key === "disposition" || key === "route" || key === "status" ||
    key === "correctionKind" || key === "findingCategory" ||
    key === "requiredOutcomeResolution" || key === "goalCoverage" ||
    key === "semanticFidelity";
}

function isIdentityString(key: string | undefined): boolean {
  if (!key) return false;
  return key === "id" || key === "sha256" || key.endsWith("Id") ||
    key.endsWith("Ids") || key.endsWith("Ref") || key.endsWith("Refs");
}

function identityArraySchema(
  value: unknown[],
  key: string | undefined,
): Record<string, unknown> | undefined {
  if (!isIdentityString(key) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return { type: "string", enum: value };
}

function isSemanticList(key: string | undefined): boolean {
  return key === "nonGoals";
}

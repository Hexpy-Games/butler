import type { PromptOptions } from "../runtime-contracts.ts";

type StructuredResponseFormat = NonNullable<PromptOptions["responseFormat"]>;
type InstancePathToken = string | "*";

export interface DeferredOpenAISchemaAssertion {
  keyword: "uniqueItems";
  instancePath: InstancePathToken[];
}

export interface CompiledOpenAIResponseFormat {
  format: StructuredResponseFormat;
  deferredAssertions: DeferredOpenAISchemaAssertion[];
}

export class OpenAIStructuredResponseValidationError extends Error {
  readonly code = "provider_structured_output_constraint_invalid";

  constructor(
    readonly instancePath: string,
    readonly keyword: "json" | DeferredOpenAISchemaAssertion["keyword"],
  ) {
    super(`${"provider_structured_output_constraint_invalid"}:${instancePath}:${keyword}`);
    this.name = "OpenAIStructuredResponseValidationError";
  }
}

export function compileOpenAIResponseFormat(
  canonical: StructuredResponseFormat,
): CompiledOpenAIResponseFormat {
  const deferredAssertions: DeferredOpenAISchemaAssertion[] = [];
  const schema = compileSchemaNode(
    canonical.schema,
    [],
    deferredAssertions,
  ) as Record<string, unknown>;
  return {
    format: {
      ...canonical,
      schema,
    },
    deferredAssertions: deduplicateAssertions(deferredAssertions),
  };
}

export function validateOpenAIStructuredResponse(
  text: string,
  compiled: CompiledOpenAIResponseFormat,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new OpenAIStructuredResponseValidationError("$", "json");
  }
  for (const assertion of compiled.deferredAssertions) {
    for (const candidate of valuesAtPath(decoded, assertion.instancePath)) {
      if (
        assertion.keyword === "uniqueItems" &&
        Array.isArray(candidate.value) &&
        !hasUniqueJsonValues(candidate.value)
      ) {
        throw new OpenAIStructuredResponseValidationError(
          candidate.displayPath,
          assertion.keyword,
        );
      }
    }
  }
}

function compileSchemaNode(
  value: unknown,
  instancePath: InstancePathToken[],
  deferred: DeferredOpenAISchemaAssertion[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => compileSchemaNode(entry, instancePath, deferred));
  }
  if (!isRecord(value)) return value;

  const compiled: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "uniqueItems") {
      if (child === true) {
        deferred.push({ keyword: "uniqueItems", instancePath: [...instancePath] });
      }
      continue;
    }
    if (key === "properties" && isRecord(child)) {
      compiled[key] = Object.fromEntries(
        Object.entries(child).map(([property, propertySchema]) => [
          property,
          compileSchemaNode(propertySchema, [...instancePath, property], deferred),
        ]),
      );
      continue;
    }
    if (key === "items") {
      compiled[key] = compileSchemaNode(child, [...instancePath, "*"], deferred);
      continue;
    }
    if (key === "prefixItems" && Array.isArray(child)) {
      compiled[key] = child.map((entry, index) =>
        compileSchemaNode(entry, [...instancePath, String(index)], deferred));
      continue;
    }
    if ((key === "additionalProperties" || key === "patternProperties") && isRecord(child)) {
      compiled[key] = compileSchemaNode(child, [...instancePath, "*"], deferred);
      continue;
    }
    compiled[key] = compileSchemaNode(child, instancePath, deferred);
  }
  return compiled;
}

function deduplicateAssertions(
  assertions: DeferredOpenAISchemaAssertion[],
): DeferredOpenAISchemaAssertion[] {
  const seen = new Set<string>();
  return assertions.filter((assertion) => {
    const key = `${assertion.keyword}:${assertion.instancePath.join("/")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function valuesAtPath(
  root: unknown,
  path: InstancePathToken[],
): Array<{ value: unknown; displayPath: string }> {
  let candidates = [{ value: root, displayPath: "$" }];
  for (const token of path) {
    candidates = candidates.flatMap((candidate) => {
      if (token === "*") {
        if (Array.isArray(candidate.value)) {
          return candidate.value.map((value, index) => ({
            value,
            displayPath: `${candidate.displayPath}[${index}]`,
          }));
        }
        if (isRecord(candidate.value)) {
          return Object.entries(candidate.value).map(([key, value]) => ({
            value,
            displayPath: `${candidate.displayPath}.${key}`,
          }));
        }
        return [];
      }
      if (Array.isArray(candidate.value) && /^\d+$/u.test(token)) {
        const index = Number(token);
        return index in candidate.value
          ? [{ value: candidate.value[index], displayPath: `${candidate.displayPath}[${index}]` }]
          : [];
      }
      if (!isRecord(candidate.value) || !(token in candidate.value)) return [];
      return [{
        value: candidate.value[token],
        displayPath: `${candidate.displayPath}.${token}`,
      }];
    });
  }
  return candidates;
}

function hasUniqueJsonValues(values: unknown[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

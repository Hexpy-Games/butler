import type { FunctionToolDefinition } from "../../../integrations/providers/runtime-contracts.ts";

export function guidedToolDefinition<T extends FunctionToolDefinition>(
  tool: T,
): T {
  const properties = tool.parameters.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return tool;
  if (tool.name === "web_read") {
    const { backend: _runtimeOwnedBackend, ...modelProperties } =
      properties as Record<string, unknown>;
    return {
      ...tool,
      parameters: { ...tool.parameters, properties: modelProperties },
    } as T;
  }
  if (tool.name !== "write_file" && tool.name !== "edit_file") return tool;
  const { expected_sha256: _runtimeOwnedHash, ...withoutRuntimeHash } =
    properties as Record<string, unknown>;
  const modelProperties = { ...withoutRuntimeHash };
  if (tool.name === "edit_file") stripRuntimeOwnedExpectedSha(modelProperties);
  if (tool.name === "write_file") delete modelProperties.overwrite;
  const required = Array.isArray(tool.parameters.required)
    ? tool.parameters.required.filter(
        (field): field is string =>
          typeof field === "string" &&
          field !== "expected_sha256" &&
          (tool.name !== "write_file" || field !== "overwrite"),
      )
    : undefined;
  return {
    ...tool,
    ...(tool.name === "write_file"
      ? {
          description: [
            "Set one UTF-8 workspace file to its complete desired content.",
            "The runtime safely creates a missing file or replaces an existing file after observing its current bytes.",
            "content is never a patch, fragment, or append; use edit_file for a small exact change to an existing file.",
            "Use Project Ledger tools for Ledger files.",
          ].join(" "),
        }
      : tool.name === "edit_file"
        ? {
            description: [
              "Apply one exact text edit or a batch of exact text edits to existing workspace files.",
              "The runtime observes each file and injects its stale-state guard; provide only path, start_line, old_text, and new_text.",
              "Use Project Ledger tools for Ledger files.",
            ].join(" "),
          }
        : {}),
    parameters: {
      ...tool.parameters,
      properties: modelProperties,
      ...(tool.name === "edit_file"
        ? stripExpectedFromParameters(tool.parameters)
        : {}),
      ...(required ? { required } : {}),
    },
  } as T;
}

function stripExpectedFromParameters(
  parameters: FunctionToolDefinition["parameters"],
): { oneOf?: unknown } {
  if (!Array.isArray(parameters.oneOf)) return {};
  const oneOf = parameters.oneOf
    .map((item) => cleanSchemaNode(structuredClone(item)))
    .filter((item): item is unknown => item !== undefined);
  return { oneOf };
}

function stripRuntimeOwnedExpectedSha(value: Record<string, unknown>): void {
  const cleaned = cleanSchemaNode(value);
  for (const key of Object.keys(value)) delete value[key];
  if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    Object.assign(value, cleaned);
  }
}

function cleanSchemaNode(value: unknown): unknown | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanSchemaNode(item))
      .filter((item): item is unknown => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  let hadRequired = false;
  let hadCombinator = false;
  for (const [key, child] of Object.entries(record)) {
    if (key === "expected_sha256") continue;
    if (key === "required" && Array.isArray(child)) {
      hadRequired = true;
      const required = child.filter((item) => item !== "expected_sha256");
      if (required.length > 0) output.required = required;
      continue;
    }
    if (
      (key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(child)
    ) {
      hadCombinator = true;
      const combinator = child
        .map((item) => cleanSchemaNode(item))
        .filter((item): item is unknown => item !== undefined);
      if (combinator.length > 0) output[key] = combinator;
      continue;
    }
    const cleaned = cleanSchemaNode(child);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  if (hadRequired && Object.keys(output).length === 0) return undefined;
  if (hadCombinator && Object.keys(output).length === 0) return undefined;
  return output;
}

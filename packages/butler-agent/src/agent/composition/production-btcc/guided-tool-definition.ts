import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";

export function guidedToolDefinition<T extends FunctionToolDefinition>(tool: T): T {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return tool;
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
  if (tool.name === "write_file") delete modelProperties.overwrite;
  const required = Array.isArray(tool.parameters.required)
    ? tool.parameters.required.filter((field): field is string =>
      typeof field === "string" && field !== "expected_sha256" &&
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
      : {}),
    parameters: {
      ...tool.parameters,
      properties: modelProperties,
      ...(required ? { required } : {}),
    },
  } as T;
}

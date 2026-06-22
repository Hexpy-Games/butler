import { expect, test } from "bun:test";
import {
  BUTLER_TOOLS,
  TOOL_CAPABILITY_METADATA,
} from "../../packages/butler-agent/src/agent/tools/registry.ts";
import {
  buildExternalToolCatalog,
  buildNativeToolCatalog,
  schemaDigest,
} from "../../packages/butler-agent/src/agent/tools/progressive-catalog.ts";

test("native progressive catalog exposes compact stable metadata without raw schemas", () => {
  const catalog = buildNativeToolCatalog({
    tools: BUTLER_TOOLS,
    metadata: TOOL_CAPABILITY_METADATA,
    resolveAvailability: (tool) => tool.name === "web_search"
      ? { enabled: false, disabledReason: "web search provider is disabled by configuration" }
      : null,
  });

  expect(catalog).toEqual(buildNativeToolCatalog({
    tools: [...BUTLER_TOOLS].reverse(),
    metadata: TOOL_CAPABILITY_METADATA,
    resolveAvailability: (tool) => tool.name === "web_search"
      ? { enabled: false, disabledReason: "web search provider is disabled by configuration" }
      : null,
  }));
  expect(catalog.every((entry) => entry.id === `${entry.provider}:${entry.name}`)).toBe(true);

  const webSearch = catalog.find((entry) => entry.name === "web_search");
  expect(webSearch).toEqual(expect.objectContaining({
    id: "native:web_search",
    provider: "native",
    category: "search",
    riskLevel: "medium",
    enabled: false,
    disabledReason: "web search provider is disabled by configuration",
    recoveryHint: "Use tool_search or tool_describe to choose another currently enabled tool.",
  }));
  expect(webSearch?.schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(webSearch?.tags).toEqual([...webSearch!.tags].sort());

  for (const entry of catalog) {
    expect(Object.keys(entry).sort()).toEqual([
      "category",
      "disabledReason",
      "enabled",
      "id",
      "name",
      "namespace",
      "provider",
      "recoveryHint",
      "riskLevel",
      "schemaDigest",
      "summary",
      "tags",
    ]);
    expect(JSON.stringify(entry)).not.toContain("\"parameters\"");
    expect(JSON.stringify(entry)).not.toContain("\"properties\"");
    expect(JSON.stringify(entry)).not.toContain("\"required\"");
  }
});

test("native progressive catalog assigns conservative risk levels from real tool metadata", () => {
  const catalog = buildNativeToolCatalog({
    tools: BUTLER_TOOLS,
    metadata: TOOL_CAPABILITY_METADATA,
  });
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));

  expect(byName.get("run_command")?.riskLevel).toBe("high");
  expect(byName.get("write_file")?.riskLevel).toBe("high");
  expect(byName.get("grep_files")).toEqual(expect.objectContaining({
    category: "file",
    riskLevel: "medium",
    tags: expect.arrayContaining(["file", "grep", "native", "search"]),
  }));
  expect(byName.get("read_file")?.riskLevel).toBe("medium");
  expect(byName.get("list_tool_capabilities")?.riskLevel).toBe("low");
});

test("native progressive catalog requires metadata for every native tool", () => {
  expect(BUTLER_TOOLS.every((tool) => Boolean(TOOL_CAPABILITY_METADATA[tool.name]))).toBe(true);
  expect(() => buildNativeToolCatalog({
    tools: BUTLER_TOOLS,
    metadata: {},
  })).toThrow("Missing native tool capability metadata: web_search");
});

test("native progressive catalog gives disabled tools a recoverable reason", () => {
  const catalog = buildNativeToolCatalog({
    tools: BUTLER_TOOLS,
    metadata: TOOL_CAPABILITY_METADATA,
    resolveAvailability: (tool) => tool.name === "web_search"
      ? { enabled: false, disabledReason: null }
      : null,
  });

  expect(catalog.find((entry) => entry.name === "web_search")).toEqual(expect.objectContaining({
    enabled: false,
    disabledReason: "tool is disabled by runtime availability policy",
    recoveryHint: "Use tool_search or tool_describe to choose another currently enabled tool.",
  }));
});

test("external catalog entries support mcp, plugin, disabled reasons, and schema digests", () => {
  const catalog = buildExternalToolCatalog([
    {
      provider: "plugin",
      namespace: "calendar",
      name: "create_event",
      category: "automation",
      description: "Create a calendar event.",
      schema: { required: ["title"], properties: { title: { type: "string" } } },
    },
    {
      provider: "mcp",
      namespace: "github",
      name: "search_issues",
      category: "mcp",
      description: "Search issues on a configured GitHub MCP server.",
      disabledReason: "server is disabled",
      schema: { properties: { query: { type: "string" } }, required: ["query"] },
    },
  ]);

  expect(catalog.map((entry) => entry.id)).toEqual([
    "mcp:github:search_issues",
    "plugin:calendar:create_event",
  ]);
  expect(catalog[0]).toEqual(expect.objectContaining({
    provider: "mcp",
    namespace: "github",
    enabled: false,
    disabledReason: "server is disabled",
    recoveryHint: "Use tool_search or tool_describe to choose another currently enabled tool.",
    riskLevel: "high",
  }));
  expect(catalog[1]).toEqual(expect.objectContaining({
    provider: "plugin",
    namespace: "calendar",
    enabled: true,
    disabledReason: null,
    recoveryHint: null,
    riskLevel: "high",
  }));
});

test("catalog ids reject empty names and escape ambiguous external segments", () => {
  const catalog = buildExternalToolCatalog([
    {
      provider: "mcp",
      namespace: "server:one",
      name: " tool:two ",
      category: "mcp",
      description: "Tool with colon-bearing provider names.",
    },
  ]);

  expect(catalog[0].id).toBe("mcp:server%3Aone:tool%3Atwo");
  expect(catalog[0].name).toBe("tool:two");
  expect(() => buildExternalToolCatalog([{
    provider: "plugin",
    name: " ",
    category: "control",
    description: "Invalid empty name.",
  }])).toThrow("Tool catalog name must not be empty");
});

test("schema digest is stable for semantically equivalent object key order", () => {
  expect(schemaDigest({
    required: ["query"],
    properties: { query: { type: "string" } },
  })).toBe(schemaDigest({
    properties: { query: { type: "string" } },
    required: ["query"],
  }));
});

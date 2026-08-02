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
import { createToolCallToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/executor.ts";
import { createToolDescribeToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_describe/executor.ts";
import { createToolSearchToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_search/executor.ts";

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
  expect(byName.get("edit_file")?.riskLevel).toBe("high");
  expect(byName.get("grep_files")).toEqual(expect.objectContaining({
    category: "file",
    riskLevel: "medium",
    tags: expect.arrayContaining(["file", "grep", "native", "search"]),
  }));
  expect(byName.get("read_file")?.riskLevel).toBe("medium");
  expect(byName.get("list_tool_capabilities")?.riskLevel).toBe("low");
});

test("Project Ledger mutation tools are discoverable in the progressive native catalog", async () => {
  const catalog = buildNativeToolCatalog({
    tools: BUTLER_TOOLS,
    metadata: TOOL_CAPABILITY_METADATA,
  });
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));

  expect(byName.get("project_ledger_task_complete")).toEqual(expect.objectContaining({
    id: "native:project_ledger_task_complete",
    category: "project",
    riskLevel: "high",
    enabled: true,
    tags: expect.arrayContaining([
      "project-ledger",
      "task",
      "state transition",
      "complete",
    ]),
  }));
  expect(byName.get("project_ledger_index")).toEqual(expect.objectContaining({
    id: "native:project_ledger_index",
    category: "project",
    riskLevel: "high",
    enabled: true,
    tags: expect.arrayContaining([
      "project-ledger",
      "native",
    ]),
  }));

  const scopedSearch = createToolSearchToolHandler({
    butlerData: "/tmp/butler-test",
    currentToolNames: ["tool_search", "tool_describe", "tool_call", "project_ledger_status"],
  });
  const scopedResult = await scopedSearch({ args: { query: "project ledger task complete", provider: "native" } }) as {
    ok: boolean;
    results: Array<{ name: string; enabled: boolean; id: string; disabled_reason: string | null; recovery_hint: string | null }>;
  };

  expect(scopedResult.ok).toBe(true);
  expect(scopedResult.results).toContainEqual(expect.objectContaining({
    id: "native:project_ledger_task_complete",
    name: "project_ledger_task_complete",
    enabled: false,
    disabled_reason: expect.stringContaining("Ledger-tracked project turn"),
    recovery_hint: expect.stringContaining("Do not mutate Project Ledger records through run_command, write_file, or edit_file"),
  }));

  const closeoutSearch = createToolSearchToolHandler({
    butlerData: "/tmp/butler-test",
    currentToolNames: [
      "tool_search",
      "tool_describe",
      "tool_call",
      "project_ledger_status",
      "project_ledger_task_complete",
    ],
  });
  const closeoutResult = await closeoutSearch({ args: { query: "project ledger task complete update", provider: "native" } }) as {
    ok: boolean;
    results: Array<{ name: string; enabled: boolean; id: string }>;
  };

  expect(closeoutResult.ok).toBe(true);
  expect(closeoutResult.results).toContainEqual(expect.objectContaining({
    id: "native:project_ledger_task_complete",
    name: "project_ledger_task_complete",
    enabled: true,
  }));
  expect(closeoutResult.results).toContainEqual(expect.objectContaining({
    id: "native:project_ledger_update",
    name: "project_ledger_update",
    enabled: true,
  }));

  const indexResult = await scopedSearch({ args: { query: "project ledger index", provider: "native" } }) as {
    ok: boolean;
    results: Array<{ name: string; enabled: boolean; id: string }>;
  };

  expect(indexResult.ok).toBe(true);
  expect(indexResult.results).toContainEqual(expect.objectContaining({
    id: "native:project_ledger_index",
    name: "project_ledger_index",
    enabled: false,
  }));
});

test("Project Ledger mutation cannot bridge from read-only project surface", async () => {
  const currentToolNames = ["tool_search", "tool_describe", "tool_call", "project_ledger_status"];
  const describe = createToolDescribeToolHandler({
    butlerData: "/tmp/butler-test",
    currentToolNames,
  });
  const description = await describe({
    args: { ids: ["native:project_ledger_task_complete", "native:project_ledger_update"] },
  }) as {
    ok: boolean;
    descriptions: Array<{
      id: string;
      enabled: boolean;
      disabled_reason: string | null;
      recovery_hint: string | null;
      call_affordance: { type: string };
    }>;
  };

  expect(description.ok).toBe(true);
  expect(description.descriptions).toEqual([
    expect.objectContaining({
      id: "native:project_ledger_task_complete",
      enabled: false,
      disabled_reason: expect.stringContaining("Ledger-tracked project turn"),
      recovery_hint: expect.stringContaining("Do not mutate Project Ledger records through run_command, write_file, or edit_file"),
      call_affordance: { type: "disabled", reason: expect.any(String) },
    }),
    expect.objectContaining({
      id: "native:project_ledger_update",
      enabled: false,
      call_affordance: { type: "disabled", reason: expect.any(String) },
    }),
  ]);

  const call = createToolCallToolHandler({
    butlerData: "/tmp/butler-test",
    currentToolNames,
    describedToolIds: ["native:project_ledger_task_complete"],
    dispatchTool: async () => {
      throw new Error("disabled lifecycle bridge must not dispatch");
    },
  });
  const result = await call({
    args: { id: "native:project_ledger_task_complete", arguments: { id: "T-1" } },
  }) as { ok: boolean; error: { code: string } };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("disabled_tool");

  const updateResult = await call({
    args: { id: "native:project_ledger_update", arguments: { id: "T-1", status: "done" } },
  }) as { ok: boolean; error: { code: string } };

  expect(updateResult.ok).toBe(false);
  expect(updateResult.error.code).toBe("disabled_tool");
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

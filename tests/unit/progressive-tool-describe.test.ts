import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { createToolDescribeToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_describe/executor.ts";
import { DisabledWebSearchProvider } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import { upsertMcpServer } from "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";

const root = process.cwd();
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(`${tmpdir()}/butler-tool-describe-`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fixtureServerEval(): string {
  return `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";

    const server = new McpServer({ name: "tool-describe-fixture", version: "1.0.0" });
    server.tool("find_issue", "Find issue records", { query: z.string() }, async ({ query }) => ({
      content: [{ type: "text", text: "issue:" + query }],
    }));
    server.resource("fixture", "butler://fixture", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture" }],
    }));
    await server.connect(new StdioServerTransport());
  `;
}

test("tool_describe returns full native schema, safety notes, and disabled reason", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    webSearchProvider: new DisabledWebSearchProvider("disabled for test"),
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["native:web_search"] },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    descriptions: Array<{
      id: string;
      enabled: boolean;
      disabled_reason: string | null;
      safety_notes: string[];
      schema: { properties?: Record<string, unknown> };
      schema_digest: string;
      call_affordance: { type: string; reason?: string | null };
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.descriptions[0]).toEqual(expect.objectContaining({
    id: "native:web_search",
    enabled: false,
    disabled_reason: "web search provider is disabled by configuration",
  }));
  expect(Object.keys(result.descriptions[0]!.schema.properties ?? {})).toContain("query");
  expect(result.descriptions[0]!.schema_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.descriptions[0]!.safety_notes.join(" ")).toContain("citations");
  expect(result.descriptions[0]!.call_affordance.type).toBe("disabled");
});

test("tool_describe returns recoverable unknown id results", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["tool_describe", "call_mcp_tool"],
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["native:nope"] },
    rawArguments: "{}",
  }) as { ok: boolean; descriptions: unknown[]; missing: Array<{ id: string; error: string }> };

  expect(result.ok).toBe(false);
  expect(result.descriptions).toEqual([]);
  expect(result.missing).toEqual([{ id: "native:nope", error: "unknown_tool_catalog_id" }]);
});

test("tool_describe returns recoverable unknown MCP id results", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["tool_describe", "call_mcp_tool"],
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["mcp:no-such:find_issue"] },
    rawArguments: "{}",
  }) as { ok: boolean; descriptions: unknown[]; missing: Array<{ id: string; error: string }> };

  expect(result.ok).toBe(false);
  expect(result.descriptions).toEqual([]);
  expect(result.missing).toEqual([{ id: "mcp:no-such:find_issue", error: "unknown_tool_catalog_id" }]);
});

test("tool_describe returns disabled MCP descriptions with recovery hints", async () => {
  upsertMcpServer(tempDir, {
    id: "disabled-fixture",
    display_name: "Disabled Fixture MCP",
    enabled: false,
    transport: "stdio",
    command: process.execPath,
    args: ["--eval", fixtureServerEval()],
    cwd: root,
  });
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["tool_describe", "call_mcp_tool"],
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["mcp:disabled-fixture:find_issue"] },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    descriptions: Array<{
      id: string;
      enabled: boolean;
      disabled_reason: string | null;
      recovery_hint: string | null;
      call_affordance: Record<string, unknown>;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.descriptions[0]).toEqual(expect.objectContaining({
    id: "mcp:disabled-fixture:find_issue",
    enabled: false,
    disabled_reason: "MCP server is disabled: disabled-fixture",
    recovery_hint: "Retry tool_describe later, choose another MCP server/tool, or continue with enabled native tools.",
    call_affordance: {
      type: "disabled",
      reason: "MCP server is disabled: disabled-fixture",
    },
  }));
});

test("tool_describe redacts MCP server unavailable details from disabled descriptions", async () => {
  upsertMcpServer(tempDir, {
    id: "unavailable-fixture",
    display_name: "Unavailable Fixture MCP",
    enabled: true,
    transport: "stdio",
    command: `${tempDir}/SECRET_TOKEN_123-missing-command`,
    args: ["--secret=SECRET_TOKEN_123"],
    cwd: root,
  });
  const describe = createToolDescribeToolHandler({
    butlerData: tempDir,
    currentToolNames: ["tool_describe", "call_mcp_tool"],
  });

  const result = await describe({
    args: { ids: ["mcp:unavailable-fixture:find_issue"] },
  }) as {
    ok: boolean;
    descriptions: Array<{
      enabled: boolean;
      disabled_reason: string | null;
      recovery_hint: string | null;
      call_affordance: Record<string, unknown>;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.descriptions[0]).toEqual(expect.objectContaining({
    enabled: false,
    disabled_reason: "MCP server unavailable.",
    recovery_hint: "Retry tool_describe later, choose another MCP server/tool, or continue with enabled native tools.",
    call_affordance: {
      type: "disabled",
      reason: "MCP server unavailable.",
    },
  }));
  expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_123");
});

test("tool_describe rejects missing catalog ids with model-recoverable feedback", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: [] },
    rawArguments: "{}",
  }) as { ok: boolean; descriptions: unknown[]; error: { code: string } };

  expect(result.ok).toBe(false);
  expect(result.descriptions).toEqual([]);
  expect(result.error.code).toBe("invalid_tool_catalog_ids");
});

test("tool_describe native ids do not wait on configured MCP probes", async () => {
  upsertMcpServer(tempDir, {
    id: "slow-fixture",
    display_name: "Slow Fixture MCP",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: ["--eval", "setTimeout(() => {}, 60_000);"],
    cwd: root,
  });
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const started = Date.now();
  const result = await execute({
    name: "tool_describe",
    args: { ids: ["native:web_read"] },
    rawArguments: "{}",
  }) as { ok: boolean; descriptions: Array<{ provider: string }> };

  expect(result.ok).toBe(true);
  expect(result.descriptions[0]?.provider).toBe("native");
  expect(Date.now() - started).toBeLessThan(900);
});

test("tool_describe native ids do not resolve plugin catalogs", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pluginToolCatalog: async () => {
      throw new Error("plugin catalog probed");
    },
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["native:web_read"] },
    rawArguments: "{}",
  }) as { ok: boolean; descriptions: Array<{ provider: string }> };

  expect(result.ok).toBe(true);
  expect(result.descriptions[0]?.provider).toBe("native");
});

test("tool_describe plugin ids use the selected-id describer without loading full plugin catalogs", async () => {
  const requested: unknown[] = [];
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pluginToolCatalog: async () => {
      throw new Error("full plugin catalog loaded");
    },
    pluginToolDescriber: async (input) => {
      requested.push(input);
      if (input.id !== "plugin:calendar:create_event") return null;
      return {
        provider: "plugin",
        namespace: input.namespace,
        name: input.name,
        category: "automation",
        description: "Create calendar events.",
        schema: { type: "object", properties: { title: { type: "string" } } },
      };
    },
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["plugin:calendar:create_event"] },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    descriptions: Array<{ provider: string; enabled: boolean; disabled_reason: string | null; call_affordance: Record<string, unknown> }>;
  };

  expect(result.ok).toBe(true);
  expect(requested).toEqual([{ id: "plugin:calendar:create_event", namespace: "calendar", name: "create_event" }]);
  expect(result.descriptions[0]).toEqual(expect.objectContaining({
    provider: "plugin",
    enabled: false,
    disabled_reason: "Plugin invocation requires a registered guarded plugin dispatcher",
    call_affordance: {
      type: "disabled",
      reason: "Plugin invocation requires a registered guarded plugin dispatcher",
    },
  }));
});

test("tool_describe converts plugin schema loading failures to recoverable disabled descriptions", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pluginToolDescriber: async () => {
      throw new Error("SECRET_TOKEN_123");
    },
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["plugin:calendar:create_event"] },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    descriptions: Array<{
      id: string;
      provider: string;
      enabled: boolean;
      disabled_reason: string | null;
      recovery_hint: string | null;
      schema: unknown;
      call_affordance: Record<string, unknown>;
    }>;
    missing: unknown[];
  };

  expect(result.ok).toBe(true);
  expect(result.missing).toEqual([]);
  expect(result.descriptions[0]).toEqual(expect.objectContaining({
    id: "plugin:calendar:create_event",
    provider: "plugin",
    enabled: false,
    disabled_reason: "Plugin schema unavailable.",
    recovery_hint: "Retry tool_describe later, choose another catalog result, or continue with enabled native/MCP tools.",
    schema: {},
    call_affordance: {
      type: "disabled",
      reason: "Plugin schema unavailable.",
    },
  }));
  expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_123");
});

test("tool_describe returns full MCP and plugin schemas for explicit ids only", async () => {
  upsertMcpServer(tempDir, {
    id: "fixture",
    display_name: "Fixture MCP",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: ["--eval", fixtureServerEval()],
    cwd: root,
  });
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["tool_describe", "call_mcp_tool"],
    pluginToolCatalog: [{
      provider: "plugin",
      namespace: "calendar",
      name: "create_event",
      category: "automation",
      description: "Create calendar events.",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", default: "private title" },
          apiKey: { type: "string", default: "secret-token" },
        },
        required: ["title"],
      },
    }],
  });

  const result = await execute({
    name: "tool_describe",
    args: { ids: ["mcp:fixture:find_issue", "plugin:calendar:create_event"] },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    descriptions: Array<{
      id: string;
      provider: string;
      enabled: boolean;
      schema: unknown;
      call_affordance: Record<string, unknown>;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.descriptions).toHaveLength(2);
  expect(result.descriptions.find((item) => item.id === "mcp:fixture:find_issue")).toEqual(
    expect.objectContaining({
      provider: "mcp",
      enabled: true,
      call_affordance: { type: "mcp_tool", server_id: "fixture", tool_name: "find_issue" },
    }),
  );
  expect(JSON.stringify(result.descriptions[0]!.schema)).toContain("query");
  expect(result.descriptions.find((item) => item.id === "plugin:calendar:create_event")).toEqual(
    expect.objectContaining({
      provider: "plugin",
      enabled: false,
      disabled_reason: "Plugin invocation requires a registered guarded plugin dispatcher",
      call_affordance: {
        type: "disabled",
        reason: "Plugin invocation requires a registered guarded plugin dispatcher",
      },
    }),
  );
  expect(JSON.stringify(result.descriptions.find((item) => item.id === "plugin:calendar:create_event")!.schema))
    .not.toContain("secret-token");
  expect(JSON.stringify(result.descriptions.find((item) => item.id === "plugin:calendar:create_event")!.schema))
    .not.toContain("private title");
});

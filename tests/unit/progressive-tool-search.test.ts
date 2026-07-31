import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  createButlerToolExecutor,
  satisfiedCompletionObligationsForToolResult,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { searchToolCatalog } from "../../packages/butler-agent/src/agent/tools/progressive-search.ts";
import { buildExternalToolCatalog } from "../../packages/butler-agent/src/agent/tools/progressive-catalog.ts";
import { createToolSearchToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_search/executor.ts";
import { DisabledWebSearchProvider } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import { upsertMcpServer } from "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";

const root = process.cwd();
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(`${tmpdir()}/butler-tool-search-`);
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

    const server = new McpServer({ name: "tool-search-fixture", version: "1.0.0" });
    server.tool("find_issue", "Find issue records", { query: z.string() }, async ({ query }) => ({
      content: [{ type: "text", text: "issue:" + query }],
    }));
    server.resource("fixture", "butler://fixture", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture" }],
    }));
    await server.connect(new StdioServerTransport());
  `;
}

test("tool_search returns compact native catalog results without raw schemas", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    webSearchProvider: new DisabledWebSearchProvider("disabled for test"),
  });

  const result = await execute({
    name: "tool_search",
    args: { category: "search", provider: "native", query: "current citations" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    results: Array<{
      id: string;
      name: string;
      provider: string;
      category: string;
      summary: string;
      tags: string[];
      enabled: boolean;
      disabled_reason: string | null;
      schema_digest: string;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.results.map((entry) => entry.name)).toContain("web_search");
  const webSearch = result.results.find((entry) => entry.name === "web_search");
  expect(webSearch).toEqual(expect.objectContaining({
    id: "native:web_search",
    provider: "native",
    category: "search",
    enabled: false,
    disabled_reason: "web search provider is disabled by configuration",
  }));
  expect(webSearch?.schema_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("\"parameters\"");
  expect(JSON.stringify(result)).not.toContain("\"properties\"");
  expect(JSON.stringify(result)).not.toContain("\"required\"");
});

test("tool_search can exclude disabled tools and reject invalid filters", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    webSearchProvider: new DisabledWebSearchProvider("disabled for test"),
  });

  const hiddenDisabled = await execute({
    name: "tool_search",
    args: { category: "search", include_disabled: false },
    rawArguments: "{}",
  }) as { ok: boolean; results: Array<{ name: string }> };
  expect(hiddenDisabled.ok).toBe(true);
  expect(hiddenDisabled.results.some((entry) => entry.name === "web_search")).toBe(false);

  const invalid = await execute({
    name: "tool_search",
    args: { provider: "private-provider" },
    rawArguments: "{}",
  }) as { ok: boolean; error: { code: string }; results: unknown[] };
  expect(invalid.ok).toBe(false);
  expect(invalid.error.code).toBe("invalid_tool_provider");
  expect(invalid.results).toEqual([]);
});

test("tool_search normalizes common execution category aliases", async () => {
  const execute = createToolSearchToolHandler({
    butlerData: tempDir,
    currentToolNames: ["tool_search", "tool_describe", "tool_call", "run_command"],
  });

  const shell = await execute({
    args: { category: "shell", query: "run command", provider: "native" },
  }) as { ok: boolean; results: Array<{ name: string; category: string }> };
  expect(shell.ok).toBe(true);
  expect(shell.results).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "run_command", category: "command" }),
  ]));

  const workspace = await execute({
    args: { category: "workspace", query: "run command", provider: "native" },
  }) as { ok: boolean; results: Array<{ name: string; category: string }> };
  expect(workspace.ok).toBe(true);
  expect(workspace.results).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "run_command", category: "command" }),
  ]));

  const all = await execute({
    args: { category: "all", query: "read file", provider: "native" },
  }) as { ok: boolean; results: Array<{ name: string; category: string }> };
  expect(all.ok).toBe(true);
  expect(all.results).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "read_file", category: "file" }),
  ]));
});

test("tool_search native provider does not wait on configured MCP probes", async () => {
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
    name: "tool_search",
    args: { provider: "native", query: "web search" },
    rawArguments: "{}",
  }) as { ok: boolean; results: Array<{ provider: string }> };

  expect(result.ok).toBe(true);
  expect(result.results.every((entry) => entry.provider === "native")).toBe(true);
  expect(Date.now() - started).toBeLessThan(900);
});

test("tool_search native provider does not resolve plugin catalogs", async () => {
  let pluginCatalogLoaded = false;
  const execute = createToolSearchToolHandler({
    butlerData: tempDir,
    pluginCatalog: async () => {
      pluginCatalogLoaded = true;
      throw new Error("plugin catalog should not load for native-only search");
    },
  });

  const result = await execute({
    args: { provider: "native", query: "web search" },
  }) as { ok: boolean; results: Array<{ provider: string }> };

  expect(result.ok).toBe(true);
  expect(pluginCatalogLoaded).toBe(false);
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results.every((entry) => entry.provider === "native")).toBe(true);
});

test("tool_search does not load MCP catalogs outside the current MCP tool profile", async () => {
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
    name: "tool_search",
    args: { provider: "mcp", category: "mcp", query: "issue" },
    rawArguments: "{}",
  }) as { ok: boolean; results: Array<{ provider: string }> };

  expect(result.ok).toBe(true);
  expect(result.results).toEqual([]);
  expect(Date.now() - started).toBeLessThan(900);
});

test("tool_search finds real configured MCP tools and redacts schemas", async () => {
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
    currentToolNames: ["tool_search", "call_mcp_tool"],
  });
  const result = await execute({
    name: "tool_search",
    args: { provider: "MCP", category: "MCP", capability: "issue" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    results: Array<{ id: string; name: string; provider: string; namespace: string | null }>;
  };

  expect(result.ok).toBe(true);
  expect(result.results).toContainEqual(expect.objectContaining({
    id: "mcp:fixture:find_issue",
    name: "find_issue",
    provider: "mcp",
    namespace: "fixture",
  }));
  expect(JSON.stringify(result)).not.toContain("\"input_schema\"");
  expect(JSON.stringify(result)).not.toContain("\"properties\"");
});

test("tool_search supports plugin catalog input without completing source obligations", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pluginToolCatalog: [{
      provider: "plugin",
      namespace: "calendar",
      name: "create_event",
      category: "automation",
      description: "Create calendar events.",
      tags: ["calendar", "event"],
    }],
  });

  const result = await execute({
    name: "tool_search",
    args: { provider: "PLUGIN", query: "calendar" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    results: Array<{
      id: string;
      provider: string;
      enabled: boolean;
      disabled_reason: string | null;
      recovery_hint: string | null;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.results).toContainEqual(expect.objectContaining({
    id: "plugin:calendar:create_event",
    provider: "plugin",
    enabled: false,
    disabled_reason: "Plugin invocation requires a registered guarded plugin dispatcher",
    recovery_hint: "Use tool_describe to inspect the plugin schema, then choose an enabled Butler or MCP tool if plugin invocation is unavailable.",
  }));
  expect(satisfiedCompletionObligationsForToolResult("tool_search", result)).toEqual([]);
});

test("catalog search supports provider, category, capability, and query ranking deterministically", () => {
  const catalog = buildExternalToolCatalog([
    {
      provider: "plugin",
      namespace: "calendar",
      name: "create_event",
      category: "automation",
      description: "Create calendar events.",
      tags: ["calendar", "event"],
    },
    {
      provider: "mcp",
      namespace: "github",
      name: "search_issues",
      category: "mcp",
      description: "Search GitHub issues.",
      tags: ["github", "issues", "search"],
    },
  ]);

  expect(searchToolCatalog({
    catalog: [...catalog].reverse(),
    provider: "mcp",
    capability: "issues",
    query: "search",
  }).map((entry) => entry.id)).toEqual(["mcp:github:search_issues"]);

  expect(searchToolCatalog({
    catalog: [...catalog].reverse(),
    category: "automation",
    query: "calendar",
  }).map((entry) => entry.id)).toEqual(["plugin:calendar:create_event"]);

  expect(searchToolCatalog({
    catalog,
    capability: "event",
    query: "browser screenshot",
  })).toEqual([]);
});

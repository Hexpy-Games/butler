import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { withTimeout } from "../../packages/butler-agent/src/interfaces/mcp-client/session.ts";
import {
  getMcpServer,
  listMcpServers,
  updateMcpServer,
  upsertMcpServer,
} from "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";

let tempDir = "";
const root = process.cwd();

beforeEach(() => {
  tempDir = mkdtempSync(`${tmpdir()}/butler-mcp-client-`);
  mkdirSync(tempDir, { recursive: true });
});

test("MCP timeout boundary rejects promptly on AbortSignal", async () => {
  const controller = new AbortController();
  const pending = withTimeout(
    new Promise<never>(() => undefined),
    30_000,
    "MCP fixture timed out",
    controller.signal,
  );
  const startedAt = performance.now();
  controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(performance.now() - startedAt).toBeLessThan(250);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fixtureServerEval(): string {
  return `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";

    const server = new McpServer({ name: "butler-fixture", version: "1.0.0" });
    server.tool("echo", "Echo text", { text: z.string() }, async ({ text }) => ({
      content: [{ type: "text", text: "echo:" + text + ":" + (process.env.MCP_FIXTURE_TOKEN ?? "") }],
    }));
    server.resource("greeting", "butler://greeting", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello from fixture" }],
    }));
    await server.connect(new StdioServerTransport());
  `;
}

test("MCP registry redacts raw values while runtime can call tools and read resources", async () => {
  upsertMcpServer(tempDir, {
    id: "fixture",
    display_name: "Fixture MCP",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: ["--eval", fixtureServerEval()],
    cwd: root,
    env: [{ key: "MCP_FIXTURE_TOKEN", source: "literal", value: "secret-token" }],
  });

  expect(listMcpServers(tempDir).servers[0]?.env[0]).toMatchObject({
    key: "MCP_FIXTURE_TOKEN",
    source: "literal",
    redacted: true,
    has_value: true,
  });
  expect(listMcpServers(tempDir).servers[0]?.env[0]?.value).toBeUndefined();

  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const capabilities = await execute({
    name: "list_mcp_capabilities",
    args: {},
    rawArguments: "{}",
  }) as {
    ok: boolean;
    servers: Array<{
      id: string;
      ok: boolean;
      tools: Array<{ name: string; qualified_name: string }>;
      resources: Array<{ uri: string }>;
    }>;
  };

  expect(capabilities.ok).toBe(true);
  expect(capabilities.servers[0]).toMatchObject({
    id: "fixture",
    ok: true,
    tools: [expect.objectContaining({ name: "echo", qualified_name: "fixture/echo" })],
    resources: [expect.objectContaining({ uri: "butler://greeting" })],
  });

  const toolResult = await execute({
    name: "call_mcp_tool",
    args: {
      server_id: "fixture",
      tool_name: "echo",
      arguments: { text: "hello" },
    },
    rawArguments: "{}",
  });
  expect(JSON.stringify(toolResult)).toContain("echo:hello:secret-token");

  const resourceResult = await execute({
    name: "read_mcp_resource",
    args: {
      server_id: "fixture",
      uri: "butler://greeting",
    },
    rawArguments: "{}",
  });
  expect(JSON.stringify(resourceResult)).toContain("hello from fixture");
});

test("MCP registry preserves redacted secrets on partial row updates", () => {
  upsertMcpServer(tempDir, {
    id: "fixture",
    display_name: "Fixture MCP",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: ["--eval", fixtureServerEval()],
    cwd: root,
    env: [
      { key: "MCP_FIXTURE_TOKEN", source: "literal", value: "secret-token" },
      { key: "MCP_VISIBLE_ENV", source: "env", value: "VISIBLE_ENV_NAME" },
    ],
  });

  const updated = updateMcpServer(tempDir, "fixture", {
    display_name: "Fixture MCP Edited",
    env: [
      { key: "MCP_FIXTURE_TOKEN", source: "literal", value: "" },
      { key: "MCP_ADDED_TOKEN", source: "literal", value: "added-token" },
    ],
  });

  expect(updated.env.map((secret) => secret.key)).toEqual([
    "MCP_FIXTURE_TOKEN",
    "MCP_ADDED_TOKEN",
  ]);
  expect(updated.env[0]).toMatchObject({
    key: "MCP_FIXTURE_TOKEN",
    redacted: true,
    has_value: true,
  });
  expect(updated.env[0]?.value).toBeUndefined();

  expect(listMcpServers(tempDir).servers[0]?.display_name).toBe("Fixture MCP Edited");
  expect(getMcpServer(tempDir, "fixture")?.env?.[0]?.value).toBe("secret-token");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { bridgeToolAuditEvent } from "../../packages/butler-agent/src/agent/tools/tool-bridge/audit.ts";
import { validateJsonObjectSchema } from "../../packages/butler-agent/src/agent/model-tool-loop/index.ts";
import { DisabledWebSearchProvider } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import type { PageReadResult } from "../../packages/butler-agent/src/integrations/search/page-reader.ts";
import { upsertMcpServer } from "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";

const root = process.cwd();
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(`${tmpdir()}/butler-tool-call-`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fixturePage(url: string): PageReadResult {
  return {
    ok: true,
    reader: "butler-lightweight",
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    title: "Example",
    method: "plain-text",
    warnings: [],
    renderRecommended: false,
    durationMs: 1,
    markdown: "Example page evidence ".repeat(40),
    text: "Example page evidence ".repeat(40),
    document: "Example page evidence ".repeat(40),
    chunks: [{
      id: "chunk-1",
      index: 0,
      title: "Example",
      url,
      text: "Example page evidence ".repeat(20),
      charCount: 440,
    }],
  };
}

function fixtureServerEval(): string {
  return `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";

    const server = new McpServer({ name: "tool-call-fixture", version: "1.0.0" });
    server.tool("find_issue", "Find issue records", { query: z.string() }, async ({ query }) => ({
      content: [{ type: "text", text: "issue:" + query }],
    }));
    await server.connect(new StdioServerTransport());
  `;
}

test("tool_call invokes native tools through the guarded Butler dispatcher", async () => {
  let pageReads = 0;
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pageReader: async (input) => {
      pageReads += 1;
      return fixturePage(input.url);
    },
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:web_read", arguments: { url: "https://example.com/source" } },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    reader: string;
    evidence_receipts: unknown[];
    bridge_invocation: { id: string; provider: string; affordance: string };
  };

  expect(result.ok).toBe(true);
  expect(result.reader).toBe("butler-lightweight");
  expect(result.evidence_receipts).toHaveLength(1);
  expect(result.bridge_invocation).toEqual({
    id: "native:web_read",
    provider: "native",
    affordance: "native_tool",
  });
  expect(pageReads).toBe(1);
});

test("tool_call returns underlying native dispatch failures as operational failures", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pageReader: async () => {
      throw new Error("reader transport unavailable");
    },
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:web_read", arguments: { url: "https://example.com/source" } },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    error: {
      code: string;
      message: string;
      recoverable: boolean;
      next_action: string;
    };
  };
  const audit = bridgeToolAuditEvent("tool_call", {
    id: "native:web_read",
    arguments: { token: "SECRET_TOKEN_123" },
  }, result);

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("underlying_tool_error");
  expect(result.error.message).toContain("reader transport unavailable");
  expect(result.error.recoverable).toBe(false);
  expect(result.error.next_action).toContain("operational tool failure");
  expect(audit?.error).toEqual({
    code: "underlying_tool_error",
    recoverable: false,
    operational_failure: true,
  });
  expect(JSON.stringify(audit)).not.toContain("SECRET_TOKEN_123");
});

test("tool_call returns recoverable schema validation results before dispatch", async () => {
  let pageReads = 0;
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pageReader: async (input) => {
      pageReads += 1;
      return fixturePage(input.url);
    },
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:web_read", arguments: { max_chars: 1000 } },
    rawArguments: "{}",
  }) as { ok: boolean; error: { code: string; recoverable: boolean; path: string } };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("invalid_tool_arguments");
  expect(result.error.recoverable).toBe(true);
  expect(result.error.path).toBe("$.url");
  expect(pageReads).toBe(0);
});

test("tool_call returns disabled tools as recoverable model-visible results", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    webSearchProvider: new DisabledWebSearchProvider("disabled for test"),
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:web_search", arguments: { query: "butler" } },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    error: {
      code: string;
      message: string;
      recoverable: boolean;
      alternatives: string[];
      next_action: string;
    };
  };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("disabled_tool");
  expect(result.error.message).toContain("web search provider is disabled");
  expect(result.error.recoverable).toBe(true);
  expect(result.error.alternatives).toContain("tool_search");
  expect(result.error.alternatives).toContain("web_read");
  expect(result.error.next_action).toContain("recoverable tool-selection result");
});

test("tool_call invokes MCP tools through call_mcp_tool", async () => {
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
    currentToolNames: ["tool_call", "tool_describe", "call_mcp_tool"],
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "mcp:fixture:find_issue", arguments: { query: "abc" } },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    server_id: string;
    tool_name: string;
    result: unknown;
    bridge_invocation: { id: string; provider: string; affordance: string };
  };

  expect(result.ok).toBe(true);
  expect(result.server_id).toBe("fixture");
  expect(result.tool_name).toBe("find_issue");
  expect(JSON.stringify(result.result)).toContain("issue:abc");
  expect(result.bridge_invocation).toEqual({
    id: "mcp:fixture:find_issue",
    provider: "mcp",
    affordance: "mcp_tool",
  });
});

test("tool_call returns plugin tools as disabled until a guarded dispatcher exists", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pluginToolCatalog: async () => {
      throw new Error("full plugin catalog loaded");
    },
    pluginToolDescriber: async (input) => ({
      provider: "plugin",
      namespace: input.namespace,
      name: input.name,
      category: "automation",
      description: "Create calendar events.",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    }),
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "plugin:calendar:create_event", arguments: { title: "Review" } },
    rawArguments: "{}",
  }) as { ok: boolean; error: { code: string; recoverable: boolean } };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("disabled_tool");
  expect(result.error.recoverable).toBe(true);
});

test("tool_call treats plugin schema loading failures as recoverable disabled targets", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    pluginToolDescriber: async () => {
      throw new Error("SECRET_TOKEN_123");
    },
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "plugin:calendar:create_event", arguments: { title: "Review" } },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    error: {
      code: string;
      message: string;
      recoverable: boolean;
      next_action: string;
    };
  };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("disabled_tool");
  expect(result.error.message).toBe("Plugin schema unavailable.");
  expect(result.error.recoverable).toBe(true);
  expect(result.error.next_action).toContain("recoverable tool-selection result");
  expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_123");
});

test("tool_call returns unknown ids as recoverable results", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:nope", arguments: {} },
    rawArguments: "{}",
  }) as { ok: boolean; error: { code: string; recoverable: boolean } };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("unknown_tool_catalog_id");
  expect(result.error.recoverable).toBe(true);
});

test("tool_call does not widen startup sessions to command tools", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["tool_call", "tool_describe", "get_context_monitor"],
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:run_command", arguments: { command: "pwd" } },
    rawArguments: "{}",
  }) as { ok: boolean; error: { code: string; message: string } };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("disabled_tool");
  expect(result.error.message).toContain("outside the current session");
});

test("tool_call validates array item schemas before dispatch", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["tool_call", "tool_describe", "grep_files"],
  });

  const result = await execute({
    name: "tool_call",
    args: { id: "native:grep_files", arguments: { pattern: "needle", include: [123] } },
    rawArguments: "{}",
  }) as { ok: boolean; error: { code: string; path: string } };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("invalid_tool_arguments");
  expect(result.error.path).toBe("$.include[0]");
});

test("tool_call schema validation rejects unknown properties when no properties map is present", () => {
  const result = validateJsonObjectSchema(
    { unexpected: true },
    { type: "object", additionalProperties: false },
  );

  expect(result).toEqual({
    ok: false,
    message: "Unexpected argument: unexpected",
    path: "$.unexpected",
    reason: "unexpected_property",
  });
});

test("schema validation enforces const and conditional oneOf requirements", () => {
  const schema = {
    type: "object",
    properties: { kind: { type: "string" }, work_id: { type: "string" } },
    required: ["kind"],
    oneOf: [
      { properties: { kind: { const: "work" } } },
      { properties: { kind: { const: "task" } }, required: ["work_id"] },
    ],
  };
  expect(validateJsonObjectSchema({ kind: "task", work_id: "W-1" }, schema)).toEqual({ ok: true });
  expect(validateJsonObjectSchema({ kind: "task" }, schema)).toMatchObject({ ok: false });
  expect(validateJsonObjectSchema({ kind: "other" }, schema)).toMatchObject({ ok: false });
});

test("schema validation reports the failure from the matching discriminated variant", () => {
  const variants = [
    {
      type: "object",
      properties: {
        kind: { const: "phase_submission" },
        submission: { type: "object" },
      },
      required: ["kind", "submission"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "operation_requests" },
        requests: { type: "array", minItems: 1 },
      },
      required: ["kind", "requests"],
    },
  ];

  expect(validateJsonObjectSchema(
    { kind: "operation_requests", requests: [] },
    { anyOf: variants },
  )).toEqual({
    ok: false,
    message: "No schema variant matched: Expected at least 1 items at $.requests",
    path: "$.requests",
    reason: "minimum_items",
  });
  expect(validateJsonObjectSchema(
    { kind: "operation_requests", requests: [] },
    { oneOf: variants },
  )).toEqual({
    ok: false,
    message: "No schema variant matched: Expected at least 1 items at $.requests",
    path: "$.requests",
    reason: "minimum_items",
  });

  const sameKindVariants = [
    {
      properties: {
        kind: { const: "observe" },
        capabilityRef: { const: "workspace:first" },
      },
      required: ["kind", "capabilityRef", "firstOnly"],
    },
    {
      properties: {
        kind: { const: "observe" },
        capabilityRef: { const: "workspace:second" },
      },
      required: ["kind", "capabilityRef", "secondOnly"],
    },
  ];
  expect(validateJsonObjectSchema(
    { kind: "observe", capabilityRef: "workspace:second" },
    { anyOf: sameKindVariants },
  )).toEqual({
    ok: false,
    message: "No schema variant matched: Missing required argument: secondOnly",
    path: "$.secondOnly",
    reason: "missing_required",
  });
  expect(validateJsonObjectSchema(
    { kind: "invalid_kind", capabilityRef: "workspace:second" },
    { anyOf: sameKindVariants },
  )).toEqual({
    ok: false,
    message: "No schema variant matched: Missing required argument: firstOnly",
    path: "$.firstOnly",
    reason: "missing_required",
  });
});

test("bridge audit metadata redacts raw tool_call arguments", () => {
  const event = bridgeToolAuditEvent(
    "tool_call",
    {
      id: "native:run_command",
      arguments: { command: "echo SECRET_TOKEN_123" },
    },
    {
      ok: false,
      error: {
        code: "disabled_tool",
        recoverable: true,
        id: "native:run_command",
      },
    },
  );

  expect(event).toEqual(expect.objectContaining({
    action: "invoke",
    outcome: "disabled",
    request: {
      id: "native:run_command",
      arguments: "[redacted]",
    },
  }));
  expect(JSON.stringify(event)).not.toContain("SECRET_TOKEN_123");
});

test("bridge audit metadata summarizes describe and denied outcomes without schemas", () => {
  const describeEvent = bridgeToolAuditEvent(
    "tool_describe",
    { ids: ["native:web_search"] },
    {
      ok: true,
      descriptions: [{
        id: "native:web_search",
        schema: { properties: { token: { default: "SECRET_TOKEN_123" } } },
        enabled: false,
      }],
      missing: [],
    },
  );
  const deniedEvent = bridgeToolAuditEvent(
    "tool_call",
    { id: "native:tool_call", arguments: { token: "SECRET_TOKEN_123" } },
    {
      ok: false,
      error: {
        code: "forbidden_bridge_target",
        recoverable: true,
        id: "native:tool_call",
      },
    },
  );

  expect(describeEvent).toEqual(expect.objectContaining({
    action: "describe",
    outcome: "ok",
    result: {
      ok: true,
      described_count: 1,
      disabled_count: 1,
      missing_count: 0,
    },
  }));
  expect(deniedEvent).toEqual(expect.objectContaining({
    action: "invoke",
    outcome: "denied",
    target: expect.objectContaining({ id: "native:tool_call" }),
  }));
  expect(JSON.stringify({ describeEvent, deniedEvent })).not.toContain("SECRET_TOKEN_123");
  expect(JSON.stringify(describeEvent)).not.toContain("properties");
});

test("bridge audit metadata keeps operational failures structurally visible", () => {
  const event = bridgeToolAuditEvent(
    "tool_call",
    { id: "native:web_search", arguments: { query: "SECRET_TOKEN_123" } },
    {
      ok: false,
      error: {
        code: "underlying_tool_error",
        recoverable: false,
        id: "native:web_search",
      },
    },
  );

  expect(event).toEqual(expect.objectContaining({
    outcome: "error",
    error: {
      code: "underlying_tool_error",
      recoverable: false,
      operational_failure: true,
    },
    target: expect.objectContaining({ id: "native:web_search" }),
  }));
  expect(JSON.stringify(event)).not.toContain("SECRET_TOKEN_123");
});

import { expect, test } from "bun:test";
import type { ModelRoundMessage } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function captureOfficialBody(oldResult: string): Promise<string> {
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let body = "";
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body);
    return Response.json({
      id: "response-next", model: "gpt-5.6-sol",
      output: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      }],
    });
  }) as typeof fetch;
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current request" },
    {
      role: "assistant", content: "", continuationItemId: "turn-item-1",
      toolCalls: [{
        id: "call-old", name: "read_file", arguments: {}, rawArguments: "{}",
      }],
    },
    {
      role: "tool", name: "read_file", toolCallId: "call-old",
      content: oldResult, continuationItemId: "turn-item-2",
    },
    {
      role: "assistant", content: "", continuationItemId: "turn-item-3",
      toolCalls: [{
        id: "call-latest", name: "web_search", arguments: {}, rawArguments: "{}",
      }],
    },
    {
      role: "tool", name: "web_search", toolCallId: "call-latest",
      content: "LATEST-RESULT", continuationItemId: "turn-item-4",
    },
  ];
  try {
    await runOpenAIModelRound({
      roundId: "round-next", model: "openai/gpt-5.6-sol", messages, tools: [],
      continuation: {
        provider: "openai", responseId: "response-prior", deliveredThroughOrdinal: 2,
      },
      boundedContinuation: {
        schemaVersion: "butler.turn-context-envelope.v1",
        modelFacingBytes: 2_000,
        requestDigest: "9".repeat(64),
        responseItemId: "turn-item-5",
        admitProviderBody: async () => {},
      },
    }, { authorization: "Bearer test", mode: "api_key" });
    return body;
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
}

test("economic replay preserves exact official Responses bytes after its watermark", async () => {
  const raw = JSON.stringify({ ok: true, content: "R".repeat(2_700) });
  const reference = JSON.stringify({
    version: "butler.operation-result-reference.v1",
    kind: "operation_result",
    identity: {
      kind: "direct", result_ref: "call-old", tool_name: "read_file",
    },
    integrity: { sha256: "a".repeat(64), revision: null },
    outcome: {
      status: "completed", success: true, verification: "stored_exact_available",
    },
    availability: {
      status: "exact_read_available", capability: "read_operation_results",
      scope: "same_turn",
    },
  });

  const beforeBody = await captureOfficialBody(raw);
  const afterBody = await captureOfficialBody(reference);
  const before = Buffer.byteLength(beforeBody);
  const after = Buffer.byteLength(afterBody);

  expect({ before, after, delta: before - after })
    .toEqual({ before: 394, after: 394, delta: 0 });
  expect(afterBody).toBe(beforeBody);
  expect(afterBody).toContain("LATEST-RESULT");
  expect(afterBody).not.toContain("call-old");
  expect(afterBody).not.toContain("butler.operation-result-reference.v1");
});

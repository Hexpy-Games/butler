import { afterEach, describe, expect, test } from "bun:test";
import { runOpenAIPromptWithUsage } from
  "../../packages/butler-agent/src/integrations/providers/openai/prompt.ts";
import type { OpenAIAuthOverride } from
  "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";

const originalFetch = globalThis.fetch;
const originalKeyPrefix = process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKeyPrefix === undefined) {
    delete process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX;
  } else {
    process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX = originalKeyPrefix;
  }
});

describe("BTCC OpenAI prompt cache request", () => {
  test("API-key GPT-5.6 marks the stable block before complete dynamic context", async () => {
    process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX = "butler:test";
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_request, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: `response-${bodies.length}`,
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "{\"accepted\":true}" }],
        }],
      });
    }) as typeof fetch;

    const stablePrefix = "{\"stablePhasePrefix\":{\"contract\":\"same\"}}\n";
    const firstDynamic = `{"dynamicTurnContent":{"turn":"one","result":"${"x".repeat(7_000)}"}}`;
    const secondDynamic = `{"dynamicTurnContent":{"turn":"two","result":"${"y".repeat(7_000)}"}}`;

    await request(stablePrefix, firstDynamic);
    await request(stablePrefix, secondDynamic);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.prompt_cache_key).toBe("butler:test:btcc:task_execution");
      expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
      expect(body.prompt_cache_retention).toBeUndefined();
      expect(body.input[0].content[0]).toEqual({
        type: "input_text",
        text: stablePrefix,
        prompt_cache_breakpoint: { mode: "explicit" },
      });
    }
    expect(bodies[0].input[0].content[0]).toEqual(bodies[1].input[0].content[0]);
    expect(bodies[0].input[0].content[1].text).toBe(firstDynamic);
    expect(bodies[1].input[0].content[1].text).toBe(secondDynamic);
  }, 15_000);

  test("Codex OAuth sends the same complete blocks under supported implicit caching", async () => {
    process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX = "butler:test";
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_request, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return codexResponse(`response-${bodies.length}`);
    }) as typeof fetch;
    const stablePrefix = `${"stable-cache-prefix ".repeat(430)}\n`;
    const firstDynamic = `{"dynamicTurnContent":{"turn":"one","result":"${"x".repeat(7_000)}"}}`;
    const secondDynamic = `{"dynamicTurnContent":{"turn":"two","result":"${"y".repeat(7_000)}"}}`;
    const auth: OpenAIAuthOverride = {
      mode: "codex_oauth",
      authorization: fakeCodexToken(),
    };

    await request(stablePrefix, firstDynamic, auth);
    await request(stablePrefix, secondDynamic, auth);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.prompt_cache_key).toBe("butler:test:btcc:task_execution");
      expect(body.prompt_cache_options).toBeUndefined();
      expect(body.prompt_cache_retention).toBeUndefined();
      expect(body.max_output_tokens).toBeUndefined();
      expect(body.input[0].content).toHaveLength(2);
      expect(body.input[0].content[0]).toEqual({
        type: "input_text",
        text: stablePrefix,
      });
      expect(body.input[0].content[1].prompt_cache_breakpoint).toBeUndefined();
    }
    expect(bodies[0].input[0].content[0]).toEqual(bodies[1].input[0].content[0]);
    expect(bodies[0].input[0].content[1]).toEqual({
      type: "input_text",
      text: firstDynamic,
    });
    expect(bodies[1].input[0].content[1]).toEqual({
      type: "input_text",
      text: secondDynamic,
    });
  }, 15_000);
});

async function request(
  stablePrefix: string,
  dynamicSuffix: string,
  auth: OpenAIAuthOverride = { mode: "api_key", authorization: "Bearer test" },
): Promise<void> {
  await runOpenAIPromptWithUsage({
    model: "gpt-5.6-sol",
    prompt: stablePrefix + dynamicSuffix,
    promptCacheBoundary: { stablePrefix, dynamicSuffix },
    cacheScope: "btcc:task_execution",
  }, auth);
}

function fakeCodexToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function codexResponse(id: string): Response {
  return new Response([
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"accepted\"}]}}",
    `data: {"type":"response.completed","response":{"id":"${id}","status":"completed"}}`,
    "data: [DONE]",
    "",
  ].join("\n\n"));
}

import { afterEach, describe, expect, test } from "bun:test";
import { runOpenAIPromptWithUsage } from
  "../../packages/butler-agent/src/integrations/providers/openai/prompt.ts";
import { codexRequestBody } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";

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
  test("marks the exact stable block before complete changing dynamic context", async () => {
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
    const packagedRequest = codexRequestBody({
      ...bodies[0],
      prompt_cache_retention: "24h",
    });
    expect(packagedRequest.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(packagedRequest.prompt_cache_retention).toBeUndefined();
    expect(packagedRequest.input).toEqual(bodies[0].input);
  }, 15_000);
});

async function request(stablePrefix: string, dynamicSuffix: string): Promise<void> {
  await runOpenAIPromptWithUsage({
    model: "gpt-5.6-sol",
    prompt: stablePrefix + dynamicSuffix,
    promptCacheBoundary: { stablePrefix, dynamicSuffix },
    cacheScope: "btcc:task_execution",
  }, {
    mode: "api_key",
    authorization: "Bearer test",
  });
}

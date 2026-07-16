import { afterEach, expect, test } from "bun:test";
import {
  compileOpenAIResponseFormat,
  validateOpenAIStructuredResponse,
} from "../../packages/butler-agent/src/integrations/providers/openai/response-schema-dialect.ts";
import { runOpenAIPromptWithUsage } from "../../packages/butler-agent/src/integrations/providers/openai/prompt.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function responseFormat() {
  return {
    type: "json_schema" as const,
    name: "nested_unique_refs",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["groups"],
      properties: {
        groups: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["refs"],
            properties: {
              refs: {
                type: "array",
                uniqueItems: true,
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

test("OpenAI response schemas compile recursively without mutating canonical authority", () => {
  const canonical = responseFormat();
  const before = structuredClone(canonical);

  const compiled = compileOpenAIResponseFormat(canonical);

  expect(canonical).toEqual(before);
  expect(JSON.stringify(compiled.format)).not.toContain("uniqueItems");
  expect(compiled.deferredAssertions).toEqual([
    { keyword: "uniqueItems", instancePath: ["groups"] },
    { keyword: "uniqueItems", instancePath: ["groups", "*", "refs"] },
  ]);
});

test("OpenAI deferred schema assertions preserve deep uniqueItems semantics", () => {
  const compiled = compileOpenAIResponseFormat(responseFormat());

  expect(() => validateOpenAIStructuredResponse(
    JSON.stringify({ groups: [{ refs: ["a", "b"] }] }),
    compiled,
  )).not.toThrow();
  expect(() => validateOpenAIStructuredResponse(
    JSON.stringify({ groups: [{ refs: ["a", "a"] }] }),
    compiled,
  )).toThrow("provider_structured_output_constraint_invalid:$.groups[0].refs:uniqueItems");
  expect(() => validateOpenAIStructuredResponse(
    JSON.stringify({
      groups: [
        { refs: ["a"] },
        { refs: ["a"] },
      ],
    }),
    compiled,
  )).toThrow("provider_structured_output_constraint_invalid:$.groups:uniqueItems");
});

test("OpenAI prompt transport sends the compiled dialect and validates the decoded response", async () => {
  const seenBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    seenBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({
      id: "resp-schema-dialect",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ groups: [{ refs: ["a", "a"] }] }),
        }],
      }],
    }), { status: 200 });
  }) as typeof fetch;

  await expect(runOpenAIPromptWithUsage({
    prompt: "Return the structured value.",
    model: "gpt-5.6-sol",
    responseFormat: responseFormat(),
  }, {
    authorization: "Bearer test-key",
    mode: "api_key",
  })).rejects.toMatchObject({
    code: "provider_structured_output_constraint_invalid",
  });

  expect(seenBodies).toHaveLength(1);
  expect(JSON.stringify(seenBodies[0]?.text)).not.toContain("uniqueItems");
});

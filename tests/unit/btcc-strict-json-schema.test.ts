import { expect, test } from "bun:test";
import {
  normalizeStrictTransportSchema,
  restoreTransportOmissions,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/strict-json-schema.ts";

test("strict transport schema makes every object property required and nullable when optional", () => {
  const schema = normalizeStrictTransportSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  });

  expect(schema.required).toEqual(["request"]);
  const request = (schema.properties as Record<string, any>).request;
  expect(request.required).toEqual(["path", "start_line"]);
  expect(request.properties.start_line).toEqual({
    anyOf: [{ type: "integer" }, { type: "null" }],
  });
});

test("strict transport restoration removes only object null placeholders", () => {
  expect(restoreTransportOmissions({
    request: { path: "README.md", start_line: null },
    values: ["kept", null],
  })).toEqual({
    request: { path: "README.md" },
    values: ["kept", null],
  });
});

import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const transformPublicDataTableToolDefinition = {
  type: "function",
  name: "transform_public_data_table",
  description: "Create a bounded CSV artifact and preview from a small set of public, non-secret row objects.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description: "Short public label for the transformed table.",
      },
      columns: {
        type: "array",
        description: "Column names to keep in the CSV, in output order.",
        items: {
          type: "string",
        },
      },
      rows: {
        type: "array",
        description: "Public row objects with primitive values only.",
        items: {
          type: "object",
          additionalProperties: {
            type: [
              "string",
              "number",
              "boolean",
              "null",
            ],
          },
        },
      },
    },
    required: [
      "columns",
      "rows",
    ],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const transformPublicDataTableToolMetadata = {
  category: "data",
  tags: [
    "data",
    "csv",
    "table",
    "transform",
    "정제",
    "표",
    "csv",
  ],
  safetyNotes: [
    "Transforms bounded public rows only; do not include secrets or private transcript text.",
  ],
} satisfies ToolCapabilityMetadata;

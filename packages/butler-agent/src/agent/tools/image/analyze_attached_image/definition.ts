import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const analyzeAttachedImageToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "analyze_attached_image",
  description:
    "Analyze one image attached to this Turn through the admitted Z.AI Vision MCP carrier. Pass the exact file_id from the current user attachment and a focused prompt; filesystem paths are not accepted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_id: {
        type: "string",
        description: "Exact file_id of an image attached to the current Turn.",
      },
      prompt: {
        type: "string",
        description: "Focused question for image analysis.",
      },
    },
    required: ["file_id", "prompt"],
  },
  effectBoundary: "dynamic",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const analyzeAttachedImageToolMetadata: ToolCapabilityMetadata = {
  category: "mcp",
  tags: ["image", "attachment", "vision", "mcp", "zai"],
  safetyNotes: [
    "Only the current Turn's admitted image file_id is accepted; the sanitized derivative is materialized in a private temporary path and removed after the MCP call.",
  ],
};


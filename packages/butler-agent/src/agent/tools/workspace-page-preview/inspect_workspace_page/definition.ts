import type {
  ButlerToolDefinition,
  ToolCapabilityMetadata,
} from "../../types.ts";

export const inspectWorkspacePageToolDefinition = {
  type: "function",
  name: "inspect_workspace_page",
  description: [
    "Render a workspace-local HTML entry in Butler App's isolated browser and inspect the actual desktop and mobile result.",
    "The tool scrolls the page to reveal lazy content, records console errors and horizontal overflow, and returns screenshots as visual evidence to the model.",
    "Use it after a successful build when the user's requested outcome depends on how a local page really looks.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      entry_path: {
        type: "string",
        description: "Workspace-relative HTML entry path, such as index.html or dist/index.html.",
      },
    },
    required: ["entry_path"],
  },
  effectBoundary: "none",
  concurrencySafe: false,
  interruptBehavior: "cancel",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const inspectWorkspacePageToolMetadata = {
  category: "file",
  tags: [
    "browser",
    "screenshot",
    "preview",
    "render",
    "responsive",
    "webpage",
    "화면",
    "스크린샷",
    "렌더링",
  ],
  safetyNotes: [
    "Renders only a guarded workspace file through the authenticated Butler App preview host.",
    "External page requests are blocked by the preview host.",
  ],
} satisfies ToolCapabilityMetadata;

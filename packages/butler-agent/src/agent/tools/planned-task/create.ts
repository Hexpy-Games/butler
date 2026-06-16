import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const createPlannedTaskToolDefinition = {
  type: "function",
  name: "create_planned_task",
  description: "Create a durable autonomous plan for complex work before any worker starts. Use this for coding, research, migrations, risky work, or tasks that need acceptance criteria and review.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: {
        type: "string",
        description: "User-facing objective for the planned work.",
      },
      internal_goal: {
        type: "string",
        description: "Internal BTCC GOAL to keep cycling against until review proves it complete. Defaults to goal.",
      },
      project_path: {
        type: "string",
        description: "Absolute project path. Defaults to the Butler repository.",
      },
      acceptance_criteria: {
        type: "array",
        description: "Specific criteria the review cycle must verify before public reporting.",
        items: {
          type: "string",
        },
      },
      verification_commands: {
        type: "array",
        description: "Commands or checks expected to verify the planned work.",
        items: {
          type: "string",
        },
      },
      risk_notes: {
        type: "array",
        description: "Known risks, constraints, or boundaries for autonomous execution.",
        items: {
          type: "string",
        },
      },
      repair_policy: {
        type: "object",
        description: "Autonomous repair policy for failed review cycles.",
        additionalProperties: false,
        properties: {
          max_attempts: {
            type: "integer",
            description: "Maximum autonomous repair attempts after the first worker attempt.",
          },
          allow_autonomous_repair: {
            type: "boolean",
            description: "Whether Butler may repair within the original objective without asking.",
          },
        },
        required: [],
      },
      public_report_policy: {
        type: "string",
        description: "How the final user-facing report should be shaped.",
      },
    },
    required: [
      "goal",
      "acceptance_criteria",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const createPlannedTaskToolMetadata = {
  category: "dispatch",
  tags: [
    "planned",
    "review",
    "acceptance",
    "complex",
    "계획",
    "검토",
    "복잡",
  ],
  safetyNotes: [
    "Creates a plan only; run_planned_task is needed to start work.",
  ],
} satisfies ToolCapabilityMetadata;

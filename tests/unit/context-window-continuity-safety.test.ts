import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDirectTurnUsage,
  beforeDirectTurnModelRequest,
  createDirectTurnBudget,
  directTurnBudgetState,
} from "../../packages/butler-agent/src/agent/turn/direct-turn-budget.ts";
import { buildThinFirstResponsePrompt } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/thin-first-response.ts";
import { compilePromptMaterialContextPlan } from "../../packages/butler-agent/src/agent/context/conversation-context.ts";
import type {
  ConversationMessageWithParts,
  ConversationPart,
  PromptMaterial,
} from "../../packages/butler-agent/src/agent/conversation/types.ts";

const INCIDENT_MODEL_REQUESTS = 27;
const INCIDENT_TOOL_PARTS = 104;

test("CWCS fixture characterizes the sanitized incident without private payloads", () => {
  const material = syntheticIncidentPromptMaterial();
  const plan = compilePromptMaterialContextPlan(material, { maxTokens: 350 });
  const prompt = buildThinFirstResponsePrompt({
    conversationContextPlan: plan,
    userText: "CURRENT_GPU_FOLLOW_UP",
    decisionInstructions: "Return a typed decision.",
  }).prompt;

  expect(material.semantic_tail.flatMap((message) => message.parts)
    .filter((part) => part.kind === "tool_result")).toHaveLength(INCIDENT_TOOL_PARTS);
  expect(plan.required_turns.map((turn) => turn.turn_id)).toEqual(["turn-adjacent-failed"]);
  expect(plan.selected_optional_turns).toEqual([]);
  expect(prompt).toContain("CURRENT_GPU_FOLLOW_UP");
  expect(prompt).not.toContain("OLDER_GPU_FALLBACK_TOPIC");
  expect(prompt).toContain("ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK");
});

test("CWCS baseline: thin prompt preserves the complete adjacent turn", () => {
  const plan = compilePromptMaterialContextPlan(syntheticIncidentPromptMaterial(), { maxTokens: 350 });
  const prompt = buildThinFirstResponsePrompt({
    conversationContextPlan: plan,
    runtimePolicy: "## Session Context Policy\ntracking_mode=none",
    userText: "집안에 남는 pc중에는 2080ti나 2070도 있긴 해.",
    decisionInstructions: "Return a typed decision.",
  }).prompt;

  expect(prompt).toContain("ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK");
  expect(prompt).not.toContain("OLDER_GPU_FALLBACK_TOPIC");
});

function syntheticIncidentPromptMaterial(): PromptMaterial {
  const oldUser = message({
    id: "message-old-user",
    turnId: "turn-old",
    seq: 1,
    role: "user",
    text: "OLDER_GPU_FALLBACK_TOPIC",
  });
  const oldAssistant = message({
    id: "message-old-tools",
    turnId: "turn-old",
    seq: 2,
    role: "assistant",
    text: "",
    parts: Array.from({ length: INCIDENT_TOOL_PARTS }, (_, index): ConversationPart => ({
      id: `part-tool-${index}`,
      message_id: "message-old-tools",
      part_index: index,
      kind: "tool_result",
      content_json: { safeLabel: `synthetic-${String(index).padStart(3, "0")}` },
      tool_call_id: `synthetic-${index}`,
      parent_tool_call_id: `synthetic-${index}`,
      provider_shape: "generic",
      status: "complete",
    })),
  });
  const adjacent = message({
    id: "message-adjacent-user",
    turnId: "turn-adjacent-failed",
    seq: 3,
    role: "user",
    text: "ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK",
  });
  return {
    session_id: "session-cwcs",
    summaries: [],
    semantic_tail: [oldUser, oldAssistant, adjacent],
    current_turn: [],
    turns: [
      {
        id: "turn-old",
        session_id: "session-cwcs",
        seq: 1,
        actor: "user",
        status: "complete",
        request_id: null,
        started_at: new Date(0).toISOString(),
        completed_at: new Date(0).toISOString(),
      },
      {
        id: "turn-adjacent-failed",
        session_id: "session-cwcs",
        seq: 2,
        actor: "user",
        status: "failed",
        request_id: null,
        started_at: new Date(0).toISOString(),
        completed_at: new Date(0).toISOString(),
      },
    ],
    token_estimate: 0,
    provenance: [],
  };
}

function message(input: {
  id: string;
  turnId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  parts?: ConversationPart[];
}): ConversationMessageWithParts {
  return {
    id: input.id,
    session_id: "session-cwcs",
    turn_id: input.turnId,
    seq: input.seq,
    role: input.role,
    status: "complete",
    visibility: "model",
    provenance: "trusted",
    created_at: new Date(0).toISOString(),
    compacted_by_summary_id: null,
    source_gateway: "app",
    source_ref: input.id,
    parts: input.parts ?? [{
      id: `part-${input.id}`,
      message_id: input.id,
      part_index: 0,
      kind: "text",
      content_json: { text: input.text },
      tool_call_id: null,
      parent_tool_call_id: null,
      provider_shape: null,
      status: "complete",
    }],
  };
}

test.failing("CWCS baseline: token overspend exhausts before another model request", () => {
  const budget = createDirectTurnBudget("turn-cwcs-incident");
  for (let index = 0; index < INCIDENT_MODEL_REQUESTS; index += 1) {
    beforeDirectTurnModelRequest(budget);
  }
  addDirectTurnUsage({
    budget,
    promptTokens: 3_221_781,
    cachedTokens: 0,
    outputTokens: 42_162,
    totalTokens: 3_263_943,
  });

  expect(directTurnBudgetState(budget).status).toBe("exhausted");
});

test.failing("CWCS boundary: provider-neutral request admission has no compaction bypass or size thresholds", () => {
  const root = join(import.meta.dir, "../..");
  const openAIToolRuntime = readFileSync(
    join(root, "packages/butler-agent/src/integrations/providers/openai/tool-runtime.ts"),
    "utf8",
  );
  const agentLoop = readFileSync(
    join(root, "packages/butler-agent/src/agent/turn/agent-loop.ts"),
    "utf8",
  );

  const forbiddenPolicyTokens = [
    openAIToolRuntime.includes("compactToolResultsBeforeNextModelCall")
      ? "openai_compaction_bypass"
      : null,
    agentLoop.includes("CHECKPOINT_SINGLE_TOOL_RESULT_TOKENS")
      ? "single_result_threshold"
      : null,
    agentLoop.includes("CHECKPOINT_CUMULATIVE_TOOL_RESULT_TOKENS")
      ? "cumulative_result_threshold"
      : null,
  ].filter(Boolean);

  expect(forbiddenPolicyTokens).toEqual([]);
});

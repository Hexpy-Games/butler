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

const INCIDENT_MODEL_REQUESTS = 27;
const INCIDENT_TOOL_PARTS = 104;

function syntheticIncidentRecentConversation(): string {
  const toolParts = Array.from({ length: INCIDENT_TOOL_PARTS }, (_, index) =>
    `tool: [tool_result:complete:synthetic-${String(index).padStart(3, "0")}] ${"evidence ".repeat(8)}`,
  );
  return [
    "## Recent Conversation",
    "user: OLDER_GPU_FALLBACK_TOPIC",
    ...toolParts,
    "user: ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK",
  ].join("\n");
}

test("CWCS fixture characterizes the sanitized incident without private payloads", () => {
  const recentConversation = syntheticIncidentRecentConversation();
  const prompt = buildThinFirstResponsePrompt({
    fullPrompt: recentConversation,
    userText: "CURRENT_GPU_FOLLOW_UP",
    decisionInstructions: "Return a typed decision.",
  }).prompt;

  expect(recentConversation.match(/\[tool_result:complete:synthetic-/gu)?.length).toBe(
    INCIDENT_TOOL_PARTS,
  );
  expect(recentConversation.indexOf("ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK")).toBeGreaterThan(
    recentConversation.indexOf("OLDER_GPU_FALLBACK_TOPIC"),
  );
  expect(prompt).toContain("CURRENT_GPU_FOLLOW_UP");
  expect(prompt).toContain("OLDER_GPU_FALLBACK_TOPIC");
  expect(prompt).not.toContain("ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK");
});

test.failing("CWCS baseline: thin prompt preserves the complete adjacent turn", () => {
  const prompt = buildThinFirstResponsePrompt({
    fullPrompt: [
      syntheticIncidentRecentConversation(),
      "## Session Context Policy",
      "tracking_mode=none",
    ].join("\n"),
    userText: "집안에 남는 pc중에는 2080ti나 2070도 있긴 해.",
    decisionInstructions: "Return a typed decision.",
  }).prompt;

  expect(prompt).toContain("ADJACENT_FAILED_REQUEST_4090_TTS_BENCHMARK");
  expect(prompt).not.toContain("OLDER_GPU_FALLBACK_TOPIC");
});

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

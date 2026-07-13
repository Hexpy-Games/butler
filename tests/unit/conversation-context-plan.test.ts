import { expect, test } from "bun:test";
import {
  compilePromptMaterialContextPlan,
  type ConversationPromptContextPlan,
} from "../../packages/butler-agent/src/agent/context/conversation-context.ts";
import type {
  ConversationMessageWithParts,
  ConversationPart,
  ConversationSummary,
  ConversationTurn,
  PromptMaterial,
  TurnOutcomeCapsule,
} from "../../packages/butler-agent/src/agent/conversation/types.ts";
import { buildThinFirstResponsePrompt } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/thin-first-response.ts";

test("optional history is a contiguous whole-turn suffix and stops at the first non-fitting turn", () => {
  const promptMaterial = material([
    semanticTurn("turn-old-small", 1, "old-small"),
    semanticTurn("turn-blocker", 3, "blocker ".repeat(600)),
    semanticTurn("turn-adjacent", 5, "adjacent-complete"),
  ]);
  const unbounded = compilePromptMaterialContextPlan(promptMaterial, { maxTokens: 100_000 });
  const adjacentCost = atom(unbounded, "turn-adjacent").serialized_tokens;
  const oldSmallCost = atom(unbounded, "turn-old-small").serialized_tokens;
  const plan = compilePromptMaterialContextPlan(promptMaterial, {
    maxTokens: adjacentCost + oldSmallCost + 100,
  });

  expect(plan.required_turns.map((turn) => turn.turn_id)).toEqual(["turn-adjacent"]);
  expect(plan.optional_turns.map((turn) => turn.turn_id)).toEqual([
    "turn-blocker",
    "turn-old-small",
  ]);
  expect(plan.selected_optional_turns).toEqual([]);
  expect(plan.rendered).toContain("adjacent-complete");
  expect(plan.rendered).not.toContain("old-small");
});

test("failed adjacent turns stay required with their user request and complete tool pairs", () => {
  const user = message("message-failed-user", "turn-failed", 1, "user", "failed user request");
  const toolMessage = message("message-failed-tools", "turn-failed", 2, "assistant", "", [
    part("message-failed-tools", 0, "tool_call", "call-1"),
    part("message-failed-tools", 1, "tool_result", "call-1"),
  ]);
  const promptMaterial = material([{
    turn: turn("turn-failed", 1, "failed"),
    messages: [user, toolMessage],
  }]);
  const plan = compilePromptMaterialContextPlan(promptMaterial, { maxTokens: 1 });

  expect(plan.required_turns).toHaveLength(1);
  expect(plan.required_turns[0]).toMatchObject({
    turn_id: "turn-failed",
    status: "failed",
  });
  expect(plan.required_turns[0]?.messages.map((item) => item.conversation_message_id)).toEqual([
    "message-failed-user",
    "message-failed-tools",
  ]);
  expect(plan.rendered).toContain("failed user request");
  expect(plan.rendered).toContain("[tool_call:probe:call-1]");
  expect(plan.rendered).toContain("[tool_result:complete:call-1]");
  expect(plan.compiled_input_tokens).toBeGreaterThan(plan.capacity_tokens);
});

test("adjacent failed turn renders its durable outcome capsule without internal tool trace", () => {
  const adjacent = semanticTurn("turn-failed-capsule", 1, "keep this exact request");
  adjacent.turn.status = "failed";
  const outcome: TurnOutcomeCapsule = {
    id: "outcome-failed",
    session_id: "session-plan",
    turn_id: adjacent.turn.id,
    generation: 2,
    outcome: "recoverable",
    source_hash: "sha256:outcome",
    request_message_id: adjacent.messages[0]!.id,
    public_assistant_message_id: null,
    provider_id: "local",
    model_ref: "local/test",
    evidence_refs: ["evidence-safe-ref"],
    unresolved_obligations: ["finish_current_request"],
    continuation: { logical_turn_id: adjacent.turn.id },
    safe_code: "admission_invariant_violation",
    created_at: new Date(0).toISOString(),
  };
  const plan = compilePromptMaterialContextPlan(
    material([adjacent], [], [outcome]),
    { maxTokens: 1 },
  );

  expect(plan.required_turns[0]?.outcome).toEqual(outcome);
  expect(plan.rendered).toContain("keep this exact request user");
  expect(plan.rendered).toContain("outcome recoverable generation 2");
  expect(plan.rendered).toContain("finish_current_request");
  expect(plan.rendered).toContain("evidence-safe-ref");
});

test("thin and full renderers share semantic atom ids and preserve nested Markdown payloads", () => {
  const summary: ConversationSummary = {
    id: "summary-older",
    session_id: "session-plan",
    covers_from_seq: 1,
    covers_to_seq: 2,
    source_hash: "sha256:summary",
    model: "openai/gpt-5.5",
    summary_text: "older complete turns",
    created_at: new Date(0).toISOString(),
    invalidated_at: null,
  };
  const promptMaterial = material([semanticTurn("turn-adjacent", 3, "adjacent answer")], [summary]);
  const plan = compilePromptMaterialContextPlan(promptMaterial, { maxTokens: 2_000 });
  const persona = [
    "## Active Persona Reminder",
    "# Neko Servant",
    "## Voice",
    "End answers with 다냐.",
    "## Boundaries",
    "Keep the character during serious answers.",
  ].join("\n");
  const thin = buildThinFirstResponsePrompt({
    conversationContextPlan: plan,
    userText: "current request",
    decisionInstructions: "typed decision",
    activePersona: persona,
  });

  expect(plan.selected_atom_ids).toEqual([
    "conversation_summary:summary-older",
    "conversation_turn:turn-adjacent",
  ]);
  expect(thin.prompt).toContain(plan.rendered);
  expect(thin.prompt).toContain(persona);
  expect(thin.prompt).toContain("## Voice\nEnd answers with 다냐.");
  expect(thin.prompt).toContain("## Boundaries\nKeep the character during serious answers.");
});

test("varied turn boundaries never produce a non-contiguous or partial optional selection", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const turns = Array.from({ length: 3 + (seed % 7) }, (_, index) =>
      semanticTurn(
        `turn-${seed}-${index}`,
        index * 2 + 1,
        `seed-${seed}-turn-${index} ${"payload ".repeat(1 + ((seed * (index + 3)) % 40))}`,
      ),
    );
    const capacity = 180 + ((seed * 137) % 1_800);
    const plan = compilePromptMaterialContextPlan(material(turns), { maxTokens: capacity });
    const selectedIds = plan.selected_optional_turns.map((turn) => turn.id);
    const optionalPrefix = plan.optional_turns.slice(0, selectedIds.length).map((turn) => turn.id);

    expect(selectedIds).toEqual(optionalPrefix);
    for (const selected of plan.selected_optional_turns) {
      for (const message of selected.messages) {
        expect(plan.rendered).toContain(message.text);
      }
    }
    for (const excluded of plan.optional_turns.slice(selectedIds.length)) {
      expect(plan.rendered).not.toContain(excluded.id.replace("conversation_turn:", "turn "));
    }
  }
});

function atom(plan: ConversationPromptContextPlan, turnId: string) {
  const found = [...plan.required_turns, ...plan.optional_turns]
    .find((candidate) => candidate.turn_id === turnId);
  if (!found) throw new Error(`missing turn atom ${turnId}`);
  return found;
}

function material(
  semanticTurns: Array<{ turn: ConversationTurn; messages: ConversationMessageWithParts[] }>,
  summaries: ConversationSummary[] = [],
  outcomes: TurnOutcomeCapsule[] = [],
): PromptMaterial {
  return {
    session_id: "session-plan",
    summaries,
    semantic_tail: semanticTurns.flatMap((item) => item.messages),
    current_turn: [],
    turns: semanticTurns.map((item) => item.turn),
    outcomes,
    token_estimate: 0,
    provenance: [],
  };
}

function semanticTurn(id: string, seq: number, text: string) {
  return {
    turn: turn(id, seq, "complete"),
    messages: [
      message(`${id}-user`, id, seq, "user", `${text} user`),
      message(`${id}-assistant`, id, seq + 1, "assistant", `${text} assistant`),
    ],
  };
}

function turn(id: string, seq: number, status: ConversationTurn["status"]): ConversationTurn {
  return {
    id,
    session_id: "session-plan",
    seq,
    actor: "user",
    status,
    request_id: null,
    started_at: new Date(0).toISOString(),
    completed_at: new Date(0).toISOString(),
  };
}

function message(
  id: string,
  turnId: string,
  seq: number,
  role: "user" | "assistant",
  text: string,
  parts?: ConversationPart[],
): ConversationMessageWithParts {
  return {
    id,
    session_id: "session-plan",
    turn_id: turnId,
    seq,
    role,
    status: "complete",
    visibility: "model",
    provenance: "trusted",
    created_at: new Date(0).toISOString(),
    compacted_by_summary_id: null,
    source_gateway: "app",
    source_ref: id,
    parts: parts ?? [{
      id: `${id}-text`,
      message_id: id,
      part_index: 0,
      kind: "text",
      content_json: { text },
      tool_call_id: null,
      parent_tool_call_id: null,
      provider_shape: null,
      status: "complete",
    }],
  };
}

function part(
  messageId: string,
  index: number,
  kind: "tool_call" | "tool_result",
  callId: string,
): ConversationPart {
  return {
    id: `${messageId}-${kind}-${index}`,
    message_id: messageId,
    part_index: index,
    kind,
    content_json: kind === "tool_call"
      ? { safeToolName: "probe" }
      : { safeLabel: "complete", ok: true },
    tool_call_id: callId,
    parent_tool_call_id: kind === "tool_result" ? callId : null,
    provider_shape: "generic",
    status: "complete",
  };
}

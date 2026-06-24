import { expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import type {
  InboundEnvelope,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  currentRuntimeTurnId,
  currentUserText,
  inboundAttachments,
  normalizeTurnPrompt,
  promptContextSection,
  stableJsonForCache,
} from "../../packages/butler-agent/src/agent/turn/native/context/turn-prompt.ts";
import {
  plannedReviewTurnContext,
} from "../../packages/butler-agent/src/agent/turn/native/context/planned-review-context.ts";
import {
  renderRecallContext,
  shouldAttemptAutomaticRecall,
} from "../../packages/butler-agent/src/agent/turn/native/context/recall-context.ts";

test("native turn context normalizes prompt sections and structured current input", () => {
  const previousButlerData = process.env.BUTLER_DATA;
  const butlerData = mkdtempSync(join(tmpdir(), "butler-native-turn-context-"));
  process.env.BUTLER_DATA = butlerData;
  try {
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "turn-context-session",
      kind: "outbound",
      payload: {
        message: {
          text: "previous answer",
          attachments: [],
        },
      },
    }));

    const input = textTurnInput("current raw", {
      promptContext: [
        "## Persona",
        "Helpful.",
        "## Current User Input",
        "stale prompt text",
      ].join("\n"),
      currentUserText: "structured user text",
    });
    const normalized = normalizeTurnPrompt(input, {
      compactionContext: "## Compaction\nsummary",
      feedbackBufferContext: "",
      workingMemoryContext: "## Working Memory\nstate",
      runtimePolicyContext: "## Runtime Policy\nrules",
      recallContext: "## Associative Recall Context\nmemory",
      recentConversationTokenBudget: 1_000,
      butlerData,
    });

    expect(normalized.prompt).toContain("## Persona\nHelpful.");
    expect(normalized.prompt).not.toContain("stale prompt text");
    expect(normalized.prompt).toContain("## Recent Conversation\nbutler: previous answer");
    expect(normalized.prompt).toContain("Message Text: structured user text");
    expect(normalized.inboundMessageChars).toBe("structured user text".length);
    expect(normalized.recentConversationChars).toBeGreaterThan(0);
  } finally {
    if (previousButlerData === undefined) {
      delete process.env.BUTLER_DATA;
    } else {
      process.env.BUTLER_DATA = previousButlerData;
    }
  }
});

test("native turn context parses planned review envelopes and inbound metadata", () => {
  const attachment = {
    id: "att-1",
    kind: "document" as const,
    fileName: "review.md",
  };
  const input = envelopeTurnInput({
    eventId: "system:planned-review:planned-abc_123:attempt-3:review-evt",
    message: {
      id: "message-id",
      text: "Worker task ID: worker-task-7",
      attachments: [attachment],
      timestamp: "2026-06-23T10:00:00.000Z",
    },
  });

  expect(plannedReviewTurnContext(input)).toEqual({
    taskId: "planned-abc_123",
    attempt: 3,
    workerTaskId: "worker-task-7",
    reviewEventId: "review-evt",
  });
  expect(currentRuntimeTurnId(input)).toBe("system:planned-review:planned-abc_123:attempt-3:review-evt");
  expect(currentUserText(input)).toBe("Worker task ID: worker-task-7");
  expect(inboundAttachments(input)).toEqual([attachment]);
  expect(shouldAttemptAutomaticRecall(input, currentUserText(input))).toBe(true);
});

test("native turn context keeps small helpers deterministic", () => {
  expect(promptContextSection("## A\none\n## B\ntwo", "A")).toBe("## A\none");
  expect(stableJsonForCache({ b: 2, a: 1 })).toBe("{\"a\":1,\"b\":2}");
  expect(renderRecallContext({
    cue: "project memory",
    seeds: [],
    abstained: false,
    items: [{
      summary: "Use project memory",
      confidence: 0.82,
      source: "project-memory",
      provenance: ["note-a", "note-b", "note-c"],
      related_nodes: [],
      score_breakdown: {
        semantic_similarity: 0,
        lexical_match: 0,
        contextual_match: 0,
        graph_activation: 0,
        recency_score: 0,
        frequency_score: 0,
        explicit_salience: 0,
        evidence_confidence: 0,
        decision_preference_boost: 0,
        hub_penalty: 0,
        conflict_penalty: 0,
        stale_superseded_penalty: 0,
        total: 0.82,
      },
    }],
    diagnostics: [],
  })).toContain("Use project memory");
});

function textTurnInput(text: string, metadata: Record<string, unknown> = {}): RuntimeTurnInput {
  return {
    handle: {
      sessionId: "turn-context-session",
      role: "butler",
      runtimeAdapterId: "native-tool-loop",
    },
    provider: {
      id: "test-provider",
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: false,
        supportsImages: false,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: false,
        supportsPromptCaching: false,
      },
      async invoke() {
        return { text: "" };
      },
    },
    model: "test/model",
    input: { text },
    metadata,
  };
}

function envelopeTurnInput(input: {
  eventId: string;
  message: InboundEnvelope["message"];
}): RuntimeTurnInput {
  return {
    ...textTurnInput("", {}),
    input: {
      eventId: input.eventId,
      transport: "app",
      accountId: "account-1",
      peer: {
        kind: "dm",
        id: "peer-1",
      },
      sender: {
        id: "user-1",
        displayName: "User",
      },
      message: input.message,
    },
  };
}

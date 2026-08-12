import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  appendRuntimeTurnContextMetric,
  contextMetricsPath,
  readContextMonitor,
} from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import { scanJsonlFile } from "../../packages/butler-agent/src/operations/metrics/jsonl-file-scanner.ts";
import {
  pruneContextMetricFiles,
} from "../../packages/butler-agent/src/agent/context/metrics-retention.ts";
import {
  AgentConversationStore,
  conversationMessagesSourceHash,
  conversationStorePath,
} from "../../packages/butler-agent/src/agent/conversation/store.ts";
import type { ConversationMessageWithParts } from "../../packages/butler-agent/src/agent/conversation/types.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-context-monitor-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function binding(workspacePath: string): StoredSessionBinding {
  const now = new Date(0).toISOString();
  return {
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
    metadata: {},
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

test("context monitor records prompt section sizes without raw prompt text", () => {
  const root = tempRoot();
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "SECRET_RUNTIME_CONTRACT", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "SECRET_ROLE_RULE", "utf8");

  try {
    const assembled = new PromptAssembler({ butlerHome, butlerData }).buildSystemPrompt(binding(butlerHome));
    const metrics = readFileSync(contextMetricsPath(butlerData), "utf8");
    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(assembled.systemPrompt).toContain("SECRET_RUNTIME_CONTRACT");
    expect(metrics).not.toContain("SECRET_RUNTIME_CONTRACT");
    expect(metrics).not.toContain("SECRET_ROLE_RULE");
    expect(summary.latestPromptAssembly?.sections.map((section) => section.id)).toEqual(["runtime-system-contract", "role"]);
    expect(summary.latestPromptAssembly?.totalChars).toBe(assembled.systemPrompt.length);
    expect(summary.privacy.rawTextStored).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor summarizes runtime turn sizes and transcript growth safely", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(
    join(butlerData, "transcripts", "butler_main.jsonl"),
    [
      JSON.stringify({
        eventId: "inbound-1",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-27T00:00:00.000Z",
        payload: { message: { text: "SECRET_USER_TEXT" } },
      }),
      JSON.stringify({
        eventId: "outbound-1",
        sessionId: "butler/main",
        kind: "outbound",
        timestamp: "2026-04-27T00:00:01.000Z",
        payload: { message: { text: "SECRET_BUTLER_TEXT" } },
      }),
    ].join("\n"),
    "utf8",
  );

  try {
    appendRuntimeTurnContextMetric({
      butlerData,
      sessionId: "butler/main",
      model: "openai/auto:codex-latest",
      totalPromptChars: 1200,
      promptContextChars: 100,
      recentConversationChars: 300,
      recallContextChars: 200,
      inboundMessageChars: 50,
      now: 1,
    });
    const metrics = readFileSync(contextMetricsPath(butlerData), "utf8");
    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(metrics).not.toContain("SECRET_USER_TEXT");
    expect(metrics).not.toContain("SECRET_BUTLER_TEXT");
    expect(summary.latestTurn).toMatchObject({
      totalPromptChars: 1200,
      recentConversationChars: 300,
      recallContextChars: 200,
      inboundMessageChars: 50,
      estimatedTokens: 300,
    });
    expect(summary.transcript).toMatchObject({
      exists: true,
      events: 2,
      conversationEvents: 2,
      latestTimestamp: "2026-04-27T00:00:01.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain(butlerData);
    expect(summary.pressure.level).toBe("low");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor computes pressure from combined prompt and turn sizes", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");

  try {
    mkdirSync(join(butlerData, "metrics"), { recursive: true });
    writeFileSync(
      contextMetricsPath(butlerData),
      [
        JSON.stringify({
          kind: "prompt_assembly",
          ts: 1,
          sessionId: "butler/main",
          role: "butler",
          totalChars: 300_000,
          sections: [{ id: "core", title: "Core", chars: 300_000 }],
        }),
        JSON.stringify({
          kind: "runtime_turn",
          ts: 2,
          sessionId: "butler/main",
          model: "openai/auto:codex-latest",
          totalPromptChars: 100_000,
          promptContextChars: 0,
          recentConversationChars: 0,
          recallContextChars: 0,
          inboundMessageChars: 0,
        }),
        "{bad json",
      ].join("\n"),
      "utf8",
    );

    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(summary.telemetry).toEqual({
      events: 2,
      parseErrors: 1,
    });
    expect(summary.pressure).toMatchObject({
      level: "low",
      thresholdState: "normal",
      contextWindowTokens: 1_050_000,
      totalChars: 400_000,
      estimatedTokens: 100_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor separates semantic pressure from audit transcript growth", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const canonicalSessionId = conversationSessionIdForDurableSession("butler/main");
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(
    join(butlerData, "transcripts", "butler_main.jsonl"),
    Array.from({ length: 200 }, (_, index) => JSON.stringify({
      eventId: `audit-${index}`,
      sessionId: "butler/main",
      kind: "turn.progress",
      timestamp: "2026-04-27T00:00:00.000Z",
      payload: { note: "AUDIT_ONLY ".repeat(100) },
    })).join("\n"),
    "utf8",
  );

  const store = new AgentConversationStore({ butlerData });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "butler/main",
      sessionId: canonicalSessionId,
      actor: "user",
    });
    store.appendUserMessage({
      sessionId: canonicalSessionId,
      turnId: turn.id,
      text: "semantic pressure only",
    });
  } finally {
    store.close();
  }

  try {
    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(summary.transcript.events).toBe(200);
    expect(summary.transcript.conversationEvents).toBe(0);
    expect(summary.conversation).toMatchObject({
      exists: true,
      sessionId: canonicalSessionId,
      semanticMessages: 1,
      summaries: 0,
    });
    expect(summary.pressure.contributors.transcriptBytes).toBeGreaterThan(10_000);
    expect(summary.pressure.contributors.semanticPromptTokens).toBeGreaterThan(0);
    expect(summary.pressure.estimatedTokens).toBe(summary.conversation.promptTokenEstimate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor streams high-cardinality conversation metadata and preserves latest summary semantics", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const sessionId = conversationSessionIdForDurableSession("butler/main");
  const totalMessages = 6_200;
  const summaryCount = 600;
  const summarizedMessages: ConversationMessageWithParts[] = [];
  const seedStore = new AgentConversationStore({ butlerData });
  let store: AgentConversationStore | null = null;
  let latestCreatedAt: string | null = null;

  try {
    const turn = seedStore.beginTurn({
      gateway: "app",
      externalSessionId: "butler/main",
      sessionId,
      actor: "user",
    });
    seedStore.close();

    const db = new Database(conversationStorePath(butlerData));
    try {
      const insertMessage = db.query(`
        INSERT INTO conversation_messages (
          id, session_id, turn_id, seq, role, status, visibility, provenance,
          created_at, compacted_by_summary_id, source_gateway, source_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertPart = db.query(`
        INSERT INTO conversation_parts (
          id, message_id, part_index, kind, content_json,
          tool_call_id, parent_tool_call_id, provider_shape, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSummary = db.query(`
        INSERT INTO conversation_summaries (
          id, session_id, covers_from_seq, covers_to_seq, source_hash,
          model, summary_text, created_at, invalidated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (let index = 0; index < totalMessages; index += 1) {
          const id = `high-cardinality-message-${index}`;
          const partId = `high-cardinality-part-${index}`;
          const text = `high-cardinality-${index}`;
          const createdAt = new Date(1_700_000_000_000 + index).toISOString();
          const message: ConversationMessageWithParts = {
            id,
            session_id: sessionId,
            turn_id: turn.id,
            seq: index + 1,
            role: "assistant",
            status: "complete",
            visibility: "model",
            provenance: "trusted",
            created_at: createdAt,
            compacted_by_summary_id: null,
            source_gateway: null,
            source_ref: null,
            parts: [{
              id: partId,
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
          if (index < summaryCount) summarizedMessages.push(message);
          latestCreatedAt = createdAt;
          insertMessage.run(
            message.id,
            message.session_id,
            message.turn_id,
            message.seq,
            message.role,
            message.status,
            message.visibility,
            message.provenance,
            message.created_at,
            message.compacted_by_summary_id,
            message.source_gateway,
            message.source_ref,
          );
          insertPart.run(
            partId,
            id,
            0,
            "text",
            JSON.stringify({ text }),
            null,
            null,
            null,
            "complete",
          );
        }
        for (const message of summarizedMessages) {
          const summaryId = `high-cardinality-summary-${message.seq}`;
          insertSummary.run(
            summaryId,
            sessionId,
            message.seq,
            message.seq,
            conversationMessagesSourceHash([message]),
            null,
            `summary-${message.seq}`,
            message.created_at,
            null,
          );
          db.query(
            "UPDATE conversation_messages SET status = 'compacted', compacted_by_summary_id = ? WHERE id = ?",
          ).run(summaryId, message.id);
        }
      })();
    } finally {
      db.close();
    }

    store = new AgentConversationStore({ butlerData });
    const expectedPromptTokens = store!.readPromptMaterial({
      sessionId,
      tailLimit: 200,
    }).token_estimate;
    store!.close();

    const originalReadMessages = AgentConversationStore.prototype.readMessages;
    const originalReadSummaries = AgentConversationStore.prototype.readSummaries;
    const originalReadPromptMaterial = AgentConversationStore.prototype.readPromptMaterial;
    AgentConversationStore.prototype.readMessages = () => {
      throw new Error("context monitor must not hydrate an unbounded message page");
    };
    AgentConversationStore.prototype.readSummaries = () => {
      throw new Error("context monitor must not materialize every summary");
    };
    AgentConversationStore.prototype.readPromptMaterial = () => {
      throw new Error("context monitor must use its bounded read model");
    };
    try {
      const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });
      expect(summary.conversation).toMatchObject({
        exists: true,
        sessionId,
        semanticMessages: totalMessages - summaryCount,
        compactedMessages: summaryCount,
        summaries: summaryCount,
        latestMessageTimestamp: latestCreatedAt,
        promptTokenEstimate: expectedPromptTokens,
      });
    } finally {
      AgentConversationStore.prototype.readMessages = originalReadMessages;
      AgentConversationStore.prototype.readSummaries = originalReadSummaries;
      AgentConversationStore.prototype.readPromptMaterial = originalReadPromptMaterial;
    }
  } finally {
    // The store is closed above before the prototype guard is installed. This
    // keeps the cleanup safe if setup fails part way through the fixture.
    try { store?.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor excludes a stale summary from authoritative prompt metadata", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const sessionId = conversationSessionIdForDurableSession("butler/main");
  const store = new AgentConversationStore({ butlerData });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "butler/main",
      sessionId,
      actor: "user",
    });
    const message = store.appendUserMessage({
      sessionId,
      turnId: turn.id,
      text: "canonical source",
    });
    store.writeSummary({
      sessionId,
      coversFromSeq: message.seq,
      coversToSeq: message.seq,
      sourceHash: conversationMessagesSourceHash([message]),
      summaryText: "authoritative before mutation",
    });
    store.close();

    const db = new Database(conversationStorePath(butlerData));
    try {
      db.query("UPDATE conversation_parts SET content_json = ? WHERE message_id = ?")
        .run(JSON.stringify({ text: "mutated source" }), message.id);
    } finally {
      db.close();
    }

    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });
    expect(summary.conversation).toMatchObject({
      semanticMessages: 1,
      compactedMessages: 0,
      summaries: 0,
      promptTokenEstimate: Math.ceil(JSON.stringify({ text: "mutated source" }).length / 4),
    });
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor keeps transcript counters in a persisted incremental index", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const transcript = join(butlerData, "transcripts", "butler_main.jsonl");
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({
    eventId: "inbound-1",
    sessionId: "butler/main",
    kind: "inbound",
    timestamp: "2026-04-27T00:00:00.000Z",
    payload: {},
  })}\n`, "utf8");

  try {
    expect(readContextMonitor({ butlerData, sessionId: "butler/main" }).transcript).toMatchObject({
      events: 1,
      conversationEvents: 1,
    });
    writeFileSync(transcript, `${readFileSync(transcript, "utf8")}${JSON.stringify({
      eventId: "outbound-1",
      sessionId: "butler/main",
      kind: "outbound",
      timestamp: "2026-04-27T00:00:01.000Z",
      payload: {},
    })}\n`, "utf8");
    const appended = readContextMonitor({ butlerData, sessionId: "butler/main" }).transcript;
    expect(appended).toMatchObject({
      events: 2,
      conversationEvents: 2,
      latestTimestamp: "2026-04-27T00:00:01.000Z",
    });
    expect(JSON.stringify(appended)).not.toContain("inbound-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor keeps a per-session bounded metric checkpoint", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "metrics"), { recursive: true });
  const rows = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
    kind: "runtime_turn",
    ts: index + 1,
    sessionId: "other/session",
    model: "openai/test",
    totalPromptChars: index,
    promptContextChars: 0,
    recentConversationChars: 0,
    recallContextChars: 0,
    inboundMessageChars: 0,
  }));
  rows.push(JSON.stringify({
    kind: "runtime_turn",
    ts: 10_000,
    sessionId: "butler/main",
    model: "openai/test",
    totalPromptChars: 400,
    promptContextChars: 0,
    recentConversationChars: 0,
    recallContextChars: 0,
    inboundMessageChars: 0,
  }));
  writeFileSync(contextMetricsPath(butlerData), `${rows.join("\n")}\n`, "utf8");

  try {
    const initial = readContextMonitor({ butlerData, sessionId: "butler/main" });
    expect(initial.telemetry.events).toBe(1);
    expect(initial.latestTurn?.totalPromptChars).toBe(400);
    expect(readdirSync(join(butlerData, "metrics", "context-summary"))).toHaveLength(1);

    appendFileSync(contextMetricsPath(butlerData), `${JSON.stringify({
      kind: "runtime_turn",
      ts: 10_001,
      sessionId: "butler/main",
      model: "openai/test",
      totalPromptChars: 500,
      promptContextChars: 0,
      recentConversationChars: 0,
      recallContextChars: 0,
      inboundMessageChars: 0,
    })}\n`, "utf8");
    const appended = readContextMonitor({ butlerData, sessionId: "butler/main" });
    expect(appended.telemetry.events).toBe(2);
    expect(appended.latestTurn?.totalPromptChars).toBe(500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transcript summary rebuilds after rotation and ignores an incomplete corrupt tail", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const transcript = join(butlerData, "transcripts", "butler_main.jsonl");
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  const first = `${JSON.stringify({
    eventId: "inbound-1",
    sessionId: "butler/main",
    kind: "inbound",
    timestamp: "2026-04-27T00:00:00.000Z",
    payload: {},
  })}\n`;
  const second = JSON.stringify({
    eventId: "outbound-1",
    sessionId: "butler/main",
    kind: "outbound",
    timestamp: "2026-04-27T00:00:01.000Z",
    payload: {},
  });
  writeFileSync(transcript, `${first}${second}\n`, "utf8");

  try {
    expect(readContextMonitor({ butlerData, sessionId: "butler/main" }).transcript.events).toBe(2);
    truncateSync(transcript, Buffer.byteLength(first));
    expect(readContextMonitor({ butlerData, sessionId: "butler/main" }).transcript).toMatchObject({
      events: 1,
      conversationEvents: 1,
    });
    appendFileSync(transcript, "{corrupt tail", "utf8");
    expect(readContextMonitor({ butlerData, sessionId: "butler/main" }).transcript.events).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSONL scanner accounts for a 20MB record without retaining it", () => {
  const root = tempRoot();
  const path = join(root, "oversized.jsonl");
  const oversized = JSON.stringify({
    kind: "turn.progress",
    payload: { note: "x".repeat(20 * 1024 * 1024) },
  });
  writeFileSync(path, oversized, "utf8");

  try {
    const lines: string[] = [];
    const records: Array<{ bytes: number; complete: boolean }> = [];
    const result = scanJsonlFile(path, {
      onLine: (line) => lines.push(line),
      onTrailing: (line) => lines.push(line),
      onOversized: (record) => records.push(record),
    });

    expect(lines).toEqual([]);
    expect(records).toEqual([{
      bytes: Buffer.byteLength(oversized),
      complete: false,
    }]);
    expect(result.oversizedLines).toBe(1);
    expect(result.oversizedBytes).toBe(Buffer.byteLength(oversized));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context metrics retention prunes old rows and malformed lines without raw text", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");

  try {
    mkdirSync(join(butlerData, "metrics"), { recursive: true });
    writeFileSync(
      contextMetricsPath(butlerData),
      [
        JSON.stringify({
          kind: "runtime_turn",
          ts: 1,
          sessionId: "butler/main",
          model: "openai/test",
          totalPromptChars: 4,
          promptContextChars: 0,
          recentConversationChars: 0,
          recallContextChars: 0,
          inboundMessageChars: 0,
        }),
        JSON.stringify({
          kind: "runtime_turn",
          ts: 10_000,
          sessionId: "butler/main",
          model: "openai/test",
          totalPromptChars: 8,
          promptContextChars: 0,
          recentConversationChars: 0,
          recallContextChars: 0,
          inboundMessageChars: 0,
        }),
        "{bad json SECRET_TEXT",
      ].join("\n"),
      "utf8",
    );

    const result = pruneContextMetricFiles({
      butlerData,
      nowMs: 10_000,
      maxAgeMs: 1_000,
    });
    const remaining = readFileSync(contextMetricsPath(butlerData), "utf8");

    expect(result.totals).toMatchObject({
      scanned: 3,
      kept: 1,
      deleted: 1,
      parseErrors: 1,
      rawTextStored: false,
    });
    const rows = remaining.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(10_000);
    expect(rows[0].rawTextStored).toBe(false);
    expect(remaining).not.toContain("SECRET_TEXT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

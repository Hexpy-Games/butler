import { expect, test } from "bun:test";
import type { GuidedToolJournalRecord } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { digest } from
  "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import { projectGuidedToolContext } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-context-projection.ts";
import { renderGuidedPrompt } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import type { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";

test("guided tool context keeps normalized continuation facts without raw arguments", () => {
  const longContent = "durable file body\n".repeat(80);
  const resultSha256 = "a".repeat(64);
  const records: GuidedToolJournalRecord[] = [{
    callId: "older-applied-call",
    toolName: "write_file",
    rawArguments: "RAW_OLDER_SECRET",
    arguments: {
      path: "src/older.ts",
      content: "small body",
      overwrite: true,
      create_parents: false,
    },
    status: "completed",
    result: {
      ok: true,
      path: "src/older.ts",
      effect_receipt: {
        receipt_id: "runtime-owned-receipt",
        capability: "write_file",
        target: "workspace:src/older.ts",
        applied_at: "2026-08-01T00:00:00.000Z",
        replayed: false,
      },
    },
    resultSha256: "b".repeat(64),
  }, {
    callId: "newer-uncertain-call",
    toolName: "write_file",
    rawArguments: "RAW_NEWER_SECRET",
    arguments: {
      path: "src/current.ts",
      content: longContent,
      overwrite: true,
      create_parents: true,
    },
    status: "completed",
    result: {
      ok: false,
      recoverable: false,
      error: {
        code: "effect_reconciliation_required",
        message: "Inspect the current target before another mutation.",
        recoverable: true,
        next_action: "Read src/current.ts and reconcile the intended bytes.",
        effect_status: "uncertain",
      },
    },
    resultSha256,
    errorCode: "stale-journal-error",
  }];

  const projected = projectGuidedToolContext(records);
  const encoded = JSON.stringify(projected);

  expect(projected.map((record) => record.tool_name)).toEqual([
    "write_file",
    "write_file",
  ]);
  expect(projected[0]).toMatchObject({
    status: "completed",
    arguments: {
      path: "src/current.ts",
      create_parents: true,
      content: {
        chars: longContent.length,
        sha256: digest(longContent),
      },
    },
    result_sha256: resultSha256,
    error: {
      code: "effect_reconciliation_required",
      message: "Inspect the current target before another mutation.",
      recoverable: true,
      next_action: "Read src/current.ts and reconcile the intended bytes.",
    },
    effect_status: "uncertain",
  });
  expect(projected[1]).toMatchObject({
    arguments: {
      path: "src/older.ts",
      create_parents: false,
    },
    effect_status: "applied",
    effect_receipt: {
      capability: "write_file",
      target: "workspace:src/older.ts",
      replayed: false,
    },
  });
  expect(encoded).not.toContain("RAW_NEWER_SECRET");
  expect(encoded).not.toContain("RAW_OLDER_SECRET");
  expect(encoded).not.toContain("rawArguments");
  expect(encoded).not.toContain("overwrite");
  expect(encoded).not.toContain("newer-uncertain-call");
  expect(encoded).not.toContain("runtime-owned-receipt");
  expect(encoded.match(/"arguments"/gu)).toHaveLength(2);
  expect(encoded.match(/effect_reconciliation_required/gu)).toHaveLength(1);
});

test("guided tool context applies newest-first record and total byte budgets", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    callId: `call-${index}`,
    toolName: "read_file",
    rawArguments: `RAW_SECRET_${index}`,
    arguments: { path: `src/file-${index}.ts` },
    status: "completed" as const,
    result: {
      path: `src/file-${index}.ts`,
      start_line: 1,
      end_line: 200,
      content: `newest fact ${index}\n${"x".repeat(5_000)}`,
    },
    resultSha256: String(index).repeat(64),
  }));

  const projected = projectGuidedToolContext(records, {
    maxRecords: 5,
    maxRecordBytes: 500,
    maxTotalBytes: 950,
  });

  expect(projected.length).toBeGreaterThan(0);
  expect(projected.length).toBeLessThanOrEqual(5);
  expect(projected[0]).toMatchObject({
    tool_name: "read_file",
    arguments: { path: "src/file-7.ts" },
    result_sha256: "7".repeat(64),
  });
  expect(projected.map((record) =>
    Number(String((record.arguments as { path: string }).path).match(/\d+/u)?.[0])))
    .toEqual(projected.map((_record, index) => 7 - index));
  for (const record of projected) {
    expect(Buffer.byteLength(JSON.stringify(record), "utf8"))
      .toBeLessThanOrEqual(500);
  }
  expect(Buffer.byteLength(JSON.stringify(projected), "utf8"))
    .toBeLessThanOrEqual(950);
  expect(JSON.stringify(projected)).not.toContain("RAW_SECRET_");
});

test("guided tool context retains string failures and older effect facts", () => {
  const longFailure = `provider rejected request: ${"x".repeat(12_000)} retry with a smaller input`;
  const records: GuidedToolJournalRecord[] = [{
    callId: "older-effect",
    toolName: "write_file",
    rawArguments: "{}",
    arguments: { path: "result.md" },
    status: "completed",
    result: {
      ok: true,
      effect_receipt: {
        capability: "write_file",
        target: "workspace:result.md",
      },
    },
  }, {
    callId: "newer-failure",
    toolName: "web_read",
    rawArguments: "{}",
    arguments: { url: "https://example.com/report" },
    status: "completed",
    result: {
      ok: false,
      error: longFailure,
      recoverable: true,
      next_action: "Use the already collected sources and draft the requested result.",
    },
    resultSha256: "c".repeat(64),
  }];

  const projected = projectGuidedToolContext(records);

  expect(projected).toHaveLength(2);
  expect(projected[0]).toMatchObject({
    tool_name: "web_read",
    error: {
      recoverable: true,
      next_action: "Use the already collected sources and draft the requested result.",
    },
  });
  const failureMessage = (projected[0]?.error as { message?: unknown })?.message;
  expect(String(failureMessage)).toContain("provider rejected request");
  expect(String(failureMessage)).toContain("retry with a smaller input");
  expect(projected[1]).toMatchObject({
    tool_name: "write_file",
    effect_status: "applied",
    effect_receipt: {
      capability: "write_file",
      target: "workspace:result.md",
    },
  });
  expect(Buffer.byteLength(JSON.stringify(projected), "utf8"))
    .toBeLessThanOrEqual(20_000);
});

test("guided prompt renders only the bounded model projection of prior tools", () => {
  const longContent = "private write payload".repeat(80);
  const records: GuidedToolJournalRecord[] = [{
    callId: "runtime-call-id",
    toolName: "write_file",
    rawArguments: "RAW_ARGUMENT_SECRET",
    arguments: {
      path: "src/resume.ts",
      content: longContent,
      overwrite: true,
      create_parents: true,
    },
    status: "started",
  }];
  const prompt = renderGuidedPrompt(turnRecord(), {
    butlerData: "/tmp/butler-data",
    contextDocuments: { resolve: () => "" },
    toolJournal: toolJournal(records),
  });

  expect(prompt).toContain("## Previously recorded tool calls for this turn");
  expect(prompt).toContain("Records are newest first.");
  expect(prompt).toContain('"tool_name":"write_file"');
  expect(prompt).toContain('"path":"src/resume.ts"');
  expect(prompt).toContain('"create_parents":true');
  expect(prompt).toContain(`"sha256":"${digest(longContent)}"`);
  expect(prompt).not.toContain("RAW_ARGUMENT_SECRET");
  expect(prompt).not.toContain("rawArguments");
  expect(prompt).not.toContain("overwrite");
  expect(prompt).not.toContain("runtime-call-id");
  expect(prompt.match(/"arguments"/gu)).toHaveLength(1);
});

function toolJournal(
  records: GuidedToolJournalRecord[],
): SqliteGuidedToolJournal {
  return { list: () => records } as unknown as SqliteGuidedToolJournal;
}

function turnRecord(): TurnRecord {
  return {
    turnId: "turn-guided-tool-context",
    sessionId: "session-guided-tool-context",
    inboxId: "inbox-guided-tool-context",
    triggerKey: "trigger-guided-tool-context",
    originalMessageId: "message-guided-tool-context",
    originalMessage: "Continue the interrupted file update.",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls-guided-tool-context",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/tmp/workspace"],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath: "/tmp/workspace",
      },
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: "checkpoint-guided-tool-context",
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}

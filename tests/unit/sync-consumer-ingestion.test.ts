import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { processEntry } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-sync-consumer-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeNativeTranscript(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [
    JSON.stringify({
      eventId: "evt-1",
      sessionId: "butler/main",
      kind: "inbound",
      timestamp: "2026-04-26T10:00:00.000Z",
      payload: { message: { text: "검색 공급자는 DDG 기본으로 기억해줘" } },
    }),
    JSON.stringify({
      eventId: "evt-2",
      sessionId: "butler/main",
      kind: "outbound",
      timestamp: "2026-04-26T10:00:05.000Z",
      payload: { message: { text: "DDG를 기본 검색 공급자로 기억하겠습니다." } },
    }),
  ].join("\n"), "utf8");
}

test("sync consumer uses normalized transcript payload for hot cache and index", () => {
  const transcriptPath = join(tempDir, "transcripts", "butler_main.jsonl");
  const saveHotPath = join(tempDir, "save_hot.ts");
  const indexPath = join(tempDir, "index.ts");
  writeNativeTranscript(transcriptPath);
  writeFileSync(saveHotPath, "", "utf8");
  writeFileSync(indexPath, "", "utf8");

  let hotInput = "";
  let indexInputPath = "";
  let indexSessionId = "";
  const result = processEntry(
    {
      project: "butler",
      topic: null,
      session_id: "butler/main",
      source: "butler",
      timestamp: "2026-04-26T10:00:30.000Z",
      trigger: "test",
    },
    {
      butlerData: tempDir,
      resolveTranscript: () => transcriptPath,
      saveHotPath,
      indexTsPath: indexPath,
      runSaveHot: (_args, _env, input) => {
        hotInput = input;
        return { status: 0, signal: null, output: [], pid: 1, stdout: "", stderr: "" };
      },
      runIndex: (args) => {
        indexInputPath = args[args.indexOf("--file") + 1] ?? "";
        indexSessionId = args[args.indexOf("--session-id") + 1] ?? "";
        expect(args).toContain("--strict");
        expect(args[args.indexOf("--source-session-id") + 1]).toBe("butler/main");
        return { status: 0, signal: null, output: [], pid: 1, stdout: "Indexed 1 chunks", stderr: "" };
      },
    },
  );

  expect(result).toMatchObject({ dequeue: true, failCount: 0 });
  expect(hotInput).toContain("user: 검색 공급자는 DDG 기본으로 기억해줘");
  expect(indexSessionId).toBe("butler_main");
  expect(indexInputPath).toContain(join(tempDir, "cognition", "memory", "queue", "normalized", "butler_main.jsonl"));
});

test("sync consumer prefers canonical conversation payload with source message ids", () => {
  const saveHotPath = join(tempDir, "save_hot.ts");
  const indexPath = join(tempDir, "index.ts");
  writeFileSync(saveHotPath, "", "utf8");
  writeFileSync(indexPath, "", "utf8");
  const canonicalSessionId = conversationSessionIdForDurableSession("butler/main");
  let next = 0;
  const store = new AgentConversationStore({
    butlerData: tempDir,
    idFactory: (prefix) => `${prefix}_sync_consumer_${++next}`,
  });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "butler/main",
      sessionId: canonicalSessionId,
      actor: "user",
      now: "2026-07-02T00:00:00.000Z",
    });
    store.appendUserMessage({
      sessionId: canonicalSessionId,
      turnId: turn.id,
      messageId: "cm_sync_consumer_user",
      text: "canonical sync consumer text",
      now: "2026-07-02T00:00:01.000Z",
    });
  } finally {
    store.close();
  }

  let hotInput = "";
  let indexInput = "";
  let resolvedTranscript = false;
  const result = processEntry(
    {
      project: "butler",
      topic: null,
      session_id: "butler/main",
      source: "butler",
      timestamp: "2026-07-02T00:00:30.000Z",
      trigger: "test",
    },
    {
      butlerData: tempDir,
      resolveTranscript: () => {
        resolvedTranscript = true;
        return null;
      },
      saveHotPath,
      indexTsPath: indexPath,
      runSaveHot: (_args, _env, input) => {
        hotInput = input;
        return { status: 0, signal: null, output: [], pid: 1, stdout: "", stderr: "" };
      },
      runIndex: (args) => {
        const indexInputPath = args[args.indexOf("--file") + 1] ?? "";
        indexInput = readFileSync(indexInputPath, "utf8");
        expect(args[args.indexOf("--source-session-id") + 1]).toBe(canonicalSessionId);
        return { status: 0, signal: null, output: [], pid: 1, stdout: "Indexed 1 chunks", stderr: "" };
      },
    },
  );

  expect(result).toMatchObject({ dequeue: true, failCount: 0 });
  expect(resolvedTranscript).toBe(false);
  expect(hotInput).toContain("user: canonical sync consumer text");
  expect(indexInput).toContain("\"source_message_ids\":[\"cm_sync_consumer_user\"]");
});

test("sync consumer rejects unsafe source provenance before indexing", () => {
  const transcriptPath = join(tempDir, "transcripts", "butler_main.jsonl");
  writeNativeTranscript(transcriptPath);
  const dlqFile = join(tempDir, "cognition", "memory", "queue", "dead-letter.jsonl");

  const result = processEntry(
    {
      project: "butler",
      topic: null,
      session_id: "butler/main",
      source: "bad source with spaces",
      timestamp: "2026-04-26T10:00:30.000Z",
      trigger: "test",
    },
    {
      butlerData: tempDir,
      dlqFile,
      resolveTranscript: () => transcriptPath,
      runIndex: () => {
        throw new Error("index must not run for unsafe provenance");
      },
    },
  );

  expect(result).toMatchObject({ dequeue: true, reason: "unsafe_source_provenance" });
  expect(readFileSync(dlqFile, "utf8")).toContain("unsafe_source_provenance");
});

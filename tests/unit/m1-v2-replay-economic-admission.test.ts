import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import { createOperationResultReplay } from
  "../../packages/butler-agent/src/agent/btcc/operation-result-replay/index.ts";
import { stableJson } from
  "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import { codexRequestBody } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";

const OBSERVED_MISSED_REPEATS = [
  [2_289, 2],
  [145, 18], [117, 17], [967, 16], [146, 16], [2_333, 15], [98, 14],
  [81, 12], [1_215, 11], [1_693, 11], [171, 10], [2_200, 9], [3_112, 8],
  [73, 6], [204, 5], [2_929, 4], [1_220, 2], [2_004, 2], [61, 1],
  [2_289, 3], [2_201, 1],
  [1_690, 2], [908, 1], [1_993, 1],
  [960, 19], [145, 18], [117, 17], [2_333, 16], [98, 15], [81, 13],
  [1_218, 11], [1_898, 11], [190, 11], [1_945, 10], [2_560, 10],
  [2_554, 10], [16, 9], [2_617, 8], [2_610, 8], [4_352, 6], [2_160, 6],
  [4_319, 5], [2_905, 5], [3_129, 4], [2_596, 2], [61, 1],
] as const;

function accepted(roundId: string) {
  return {
    text: "accepted",
    toolCalls: [],
    acceptedCheckpoint: {
      roundId,
      candidateIndex: 0,
      transportAttempt: 1,
      modelRef: "openai/gpt-5.6-sol",
    },
  };
}

test("observed sub-8-KiB result is raw once then uses a smaller exact reference", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-replay-economic-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "economic-admission",
  });
  try {
    const result = { ok: true, content: "R".repeat(2_700) };
    stores.guidedToolJournal.start({
      turnId: "turn",
      callId: "observed-small-result",
      toolName: "read_file",
      rawArguments: "{}",
      arguments: {},
    });
    stores.guidedToolJournal.finish({
      callId: "observed-small-result",
      status: "completed",
      result,
    });
    const replay = createOperationResultReplay({
      turnId: "turn",
      turnRevision: 1,
      journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true,
    });
    const raw = JSON.stringify({ ok: true, output: result });
    const messages = [{
      role: "tool" as const,
      toolCallId: "observed-small-result",
      name: "read_file",
      content: raw,
    }];

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8 * 1_024);
    expect(replay.prepareMessages(messages, "round-1")[0]!.content).toBe(raw);
    replay.accepted("round-1", accepted("round-1"));

    const repeated = replay.prepareMessages(messages, "round-2")[0]!.content;
    expect(repeated).toContain("butler.operation-result-reference.v1");
    expect(Buffer.byteLength(JSON.stringify(repeated)))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(raw)));
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("economic admission keeps a result raw when its exact reference is larger", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-replay-non-saving-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "non-saving-admission",
  });
  try {
    const result = { ok: true, value: "tiny" };
    stores.guidedToolJournal.start({
      turnId: "turn", callId: "tiny", toolName: "read_file",
      rawArguments: "{}", arguments: {},
    });
    stores.guidedToolJournal.finish({
      callId: "tiny", status: "completed", result,
    });
    const replay = createOperationResultReplay({
      turnId: "turn", turnRevision: 1,
      journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true,
    });
    const raw = JSON.stringify({ ok: true, output: result });
    const messages = [{
      role: "tool" as const, toolCallId: "tiny", name: "read_file", content: raw,
    }];

    expect(replay.prepareMessages(messages, "round-1")[0]!.content).toBe(raw);
    replay.accepted("round-1", accepted("round-1"));
    expect(replay.prepareMessages(messages, "round-2")[0]!.content).toBe(raw);
    expect(stores.guidedToolJournal.findForTurn("turn", "tiny")?.deliveryState)
      .toBeUndefined();
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable economic admission still rejects a changed stale retry round", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-replay-economic-retry-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "economic-retry",
  });
  try {
    const result = { content: "R".repeat(2_700) };
    stores.guidedToolJournal.start({
      turnId: "turn", callId: "result", toolName: "read_file",
      rawArguments: "{}", arguments: {},
    });
    stores.guidedToolJournal.finish({
      callId: "result", status: "completed", result,
    });
    const replay = createOperationResultReplay({
      turnId: "turn", turnRevision: 1,
      journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true,
    });
    replay.prepareMessages([{
      role: "tool", toolCallId: "result", content: "R".repeat(2_700),
    }], "round-a");

    expect(() => replay.prepareMessages([{
      role: "tool", toolCallId: "result", content: "tiny changed preview",
    }], "stale-round")).toThrow("operation_result_delivery_in_flight_mismatch");
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed multi-round corpus replays 482,317 fewer actual Codex JSON bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-replay-observed-corpus-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"), ownerId: "observed-corpus",
  });
  const bodyBytes = (callId: string, output: string) => Buffer.byteLength(
    JSON.stringify(codexRequestBody({
      model: "gpt-5.6-sol", input: [],
      __butler_codex_stateless_input: [{
        type: "function_call_output", call_id: callId, output,
      }],
    })),
  );
  try {
    const replay = createOperationResultReplay({
      turnId: "turn", turnRevision: 1,
      journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true,
    });
    let before = 0;
    let after = 0;
    OBSERVED_MISSED_REPEATS.forEach(([bytesSavedPerRepeat, repeatCount], index) => {
      const callId = `observed-result-${index}`;
      stores.guidedToolJournal.start({
        turnId: "turn", callId, toolName: "read_file",
        rawArguments: "{}", arguments: {},
      });
      stores.guidedToolJournal.finish({
        callId, status: "completed", result: { ok: true, index },
      });
      const record = stores.guidedToolJournal.findForTurn("turn", callId)!;
      const reference = stableJson(replay.referenceFor(record));
      const emptyBytes = bodyBytes(callId, "");
      const rawLength = bodyBytes(callId, reference) + bytesSavedPerRepeat - emptyBytes;
      const raw = "R".repeat(rawLength);
      const messages = [{
        role: "tool" as const, toolCallId: callId, name: "read_file", content: raw,
      }];

      expect(replay.prepareMessages(messages, `first-${index}`)[0]!.content).toBe(raw);
      replay.accepted(`first-${index}`, accepted(`first-${index}`));
      for (let repeat = 0; repeat < repeatCount; repeat += 1) {
        const projected = replay.prepareMessages(
          messages, `repeat-${index}-${repeat}`,
        )[0]!.content;
        expect(projected).toBe(reference);
        before += bodyBytes(callId, raw);
        after += bodyBytes(callId, projected);
      }
    });

    expect(OBSERVED_MISSED_REPEATS).toHaveLength(46);
    expect({ before, after, delta: before - after }).toEqual({
      before: 784_357, after: 302_040, delta: 482_317,
    });
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corpus-shaped sub-8-KiB sequence shrinks the actual Codex final JSON", () => {
  const raw = JSON.stringify({
    ok: true,
    output: { ok: true, content: "R".repeat(2_700) },
  });
  const reference = JSON.stringify({
    version: "butler.operation-result-reference.v1",
    kind: "operation_result",
    identity: {
      kind: "direct",
      result_ref: "observed-small-result",
      tool_name: "read_file",
    },
    integrity: { sha256: "a".repeat(64), revision: null },
    outcome: {
      status: "completed",
      success: true,
      verification: "stored_exact_available",
    },
    availability: {
      status: "exact_read_available",
      capability: "read_operation_results",
      scope: "same_turn",
    },
  });
  const body = (outputs: readonly string[]) => codexRequestBody({
    model: "gpt-5.6-sol",
    input: [],
    __butler_codex_stateless_input: outputs.map((output, index) => ({
      type: "function_call_output",
      call_id: `call-${index}`,
      output,
    })),
  });
  const before = Buffer.byteLength(JSON.stringify(body([raw, raw, raw, raw])));
  const after = Buffer.byteLength(JSON.stringify(body([
    raw, reference, reference, reference,
  ])));

  expect({ before, after, delta: before - after })
    .toEqual({ before: 11_429, after: 4_733, delta: 6_696 });
});

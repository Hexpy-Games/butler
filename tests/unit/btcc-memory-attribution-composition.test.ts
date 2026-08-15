import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/index.ts";
import type { BtccTurnRequest } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { ModelRoundPort } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import type { RuntimeMemoryAttributionPort } from
  "../../packages/butler-agent/src/operations/diagnostics/runtime-memory-attribution/index.ts";

test("production composition emits ordered memory checkpoints through one real BTCC Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-memory-attribution-composition-"));
  const dbPath = join(root, "app.sqlite");
  writeFileSync(join(root, "fixture.txt"), "attribution-check\n", "utf8");
  const sessionId = "memory-attribution-session";
  const turnId = "memory-attribution-turn";
  const bindings = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"), "ephemeral");
  const events: string[] = [];
  const attribution: RuntimeMemoryAttributionPort = {
    checkpoint(input) {
      events.push(input.event);
    },
    terminal(state) {
      events.push(`terminal:${state}`);
    },
    projectLedgerPhase() {},
    close() {},
  };
  let modelCalls = 0;
  const modelRound: ModelRoundPort = {
    async runRound() {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            toolCalls: [{
              id: "tool-call-private-id",
              name: "read_file",
              arguments: {
                path: "fixture.txt",
                max_bytes: 1_024,
              },
              rawArguments: "{\"path\":\"fixture.txt\"}",
            }],
          }
        : { text: "계측 경로 확인을 완료했습니다.", toolCalls: [] };
    },
  };
  bindings.upsert({
    sessionId,
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    metadata: { accessMode: "full_access", trackingMode: "local" },
  });
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData: root,
    appMessageDbPath: dbPath,
    ownerId: "memory-attribution-composition",
    modelRound,
    sessionBindings: bindings,
    memoryAttribution: attribution,
  });
  try {
    const result = await composition.btcc.runTurn(request({ root, sessionId, turnId }));
    expect(result).toMatchObject({
      kind: "delivered",
      turnId,
      content: "계측 경로 확인을 완료했습니다.",
    });
    expect(modelCalls).toBe(2);
    expect(events).toEqual([
      "turn_start",
      "model_call_start",
      "model_call_end",
      "tool_call_start",
      "tool_call_end",
      "model_call_start",
      "model_call_end",
      "terminal:delivered",
      "turn_end",
    ]);
  } finally {
    await composition.host.close();
    bindings.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function request(input: {
  root: string;
  sessionId: string;
  turnId: string;
}): BtccTurnRequest {
  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    eventId: `event-${input.turnId}`,
    transport: "test",
    accountId: "local",
    peer: { kind: "dm", id: "memory-attribution" },
    sender: { id: "test-user" },
    message: {
      id: `message-${input.turnId}`,
      content: "메모리 계측의 실제 BTCC 경로를 확인해 주세요.",
      timestamp: "2026-08-15T00:00:00.000Z",
    },
    trigger: { kind: "user_message" },
    route: {
      role: "butler",
      workspacePath: input.root,
      reason: "transport-binding",
    },
  };
}

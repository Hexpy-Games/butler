import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { createTurnRuntime as createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccAgentLoop as GuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { DeveloperLogStore } from
  "../../packages/butler-agent/src/operations/diagnostics/developer-log-store.ts";
import {
  createTurnDeveloperLogCapturePort,
} from
  "../../packages/butler-agent/src/operations/diagnostics/developer-log-turn-capture/index.ts";

test("Developer log capture appends one model_turn entry for a successful Guided Turn", async () => {
  const harness = harnessWithGate(() => true);
  try {
    harness.runtime = createGuidedTurnRuntime({
      ...harness.dependencies,
      agent: successAgent("개발자 로그 응답입니다."),
    });
    const command = runCommand("devlog-success-turn");
    const outcome = await harness.runtime.runTurn(command);

    expect(outcome.kind).toBe("delivered");
    expect(existsSync(harness.logPath)).toBe(true);
    const listed = harness.store.list();
    expect(listed.total).toBe(1);
    const entry = listed.entries[0];
    expect(entry).toMatchObject({
      schema: "butler.developer-log.v1",
      kind: "model_turn",
      session_id: command.sessionId,
      turn_id: command.turnId,
      role: "butler",
    });
    expect(entry?.request.input_text).toBe("안녕");
    expect(entry?.response.text).toBe("개발자 로그 응답입니다.");
    expect(entry?.model.requested_model_ref).toBe("openai/gpt-5.6-sol");
  } finally {
    harness.close();
  }
});

test("A converted operational failure appends only one model_turn_error entry", async () => {
  const harness = harnessWithGate(() => true);
  try {
    harness.runtime = createGuidedTurnRuntime({
      ...harness.dependencies,
      agent: failingAgent(new Error("model exploded mid-round")),
    });
    const outcome = await harness.runtime
      .runTurn(runCommand("devlog-converted-failure-turn"));

    expect(outcome.kind).toBe("delivered");
    const listed = harness.store.list();
    expect(listed.total).toBe(1);
    expect(listed.entries[0]).toMatchObject({ kind: "model_turn_error" });
    expect(harness.store.list({ kind: "model_turn" }).total).toBe(0);
  } finally {
    harness.close();
  }
});

test("An exhausted provider failure that rethrows still appends one error entry", async () => {
  const harness = harnessWithGate(() => true);
  try {
    harness.runtime = createGuidedTurnRuntime({
      ...harness.dependencies,
      agent: failingAgent(new ModelProviderRequestError({
        code: "provider_network_error",
        message: "provider disconnected before final answer",
        provider: "openai",
        retryable: true,
      })),
    });
    await expect(
      harness.runtime.runTurn(runCommand("devlog-provider-exhausted-turn")),
    ).rejects.toMatchObject({ code: "provider_network_error" });

    const errors = harness.store.list({ kind: "model_turn_error" });
    expect(errors.total).toBe(1);
    expect(errors.entries[0]?.request.metadata.failure_code)
      .toBe("provider_network_error");
    expect(harness.store.list({ kind: "model_turn" }).total).toBe(0);
  } finally {
    harness.close();
  }
});

test("Disabled diagnostics append nothing and toggling on captures the next turn", async () => {
  let enabled = false;
  const harness = harnessWithGate(() => enabled);
  try {
    harness.runtime = createGuidedTurnRuntime({
      ...harness.dependencies,
      agent: successAgent("게이트 응답"),
    });
    await harness.runtime.runTurn(runCommand("devlog-gate-off-turn"));
    expect(existsSync(harness.logPath)).toBe(false);

    enabled = true;
    await harness.runtime.runTurn(runCommand("devlog-gate-on-turn"));
    const listed = harness.store.list();
    expect(listed.total).toBe(1);
    expect(listed.entries[0]?.turn_id).toBe("devlog-gate-on-turn");
  } finally {
    harness.close();
  }
});

test("A throwing developer log store never fails the Guided Turn", async () => {
  const harness = harnessWithGate(() => true);
  try {
    class ExplodingStore extends DeveloperLogStore {
      override appendModelTurn(): never {
        throw new Error("capture storage exploded");
      }
      override appendModelTurnError(): never {
        throw new Error("capture storage exploded");
      }
    }
    harness.runtime = createGuidedTurnRuntime({
      admission: harness.dependencies.admission,
      turns: harness.dependencies.turns,
      messages: harness.dependencies.messages,
      developerLogCapture: createTurnDeveloperLogCapturePort({
        store: new ExplodingStore({ butlerData: "unused" }),
        gate: () => true,
      }),
      agent: successAgent("fail-open 응답"),
    });
    const outcome = await harness.runtime
      .runTurn(runCommand("devlog-fail-open-turn"));
    expect(outcome.kind).toBe("delivered");
  } finally {
    harness.close();
  }
});

test("A throwing diagnostics gate never fails the Guided Turn", async () => {
  const harness = harnessWithGate(() => {
    throw new Error("settings database unavailable");
  });
  try {
    harness.runtime = createGuidedTurnRuntime({
      ...harness.dependencies,
      agent: successAgent("gate fail-open 응답"),
    });
    const outcome = await harness.runtime
      .runTurn(runCommand("devlog-gate-throwing-turn"));
    expect(outcome.kind).toBe("delivered");
    expect(existsSync(harness.logPath)).toBe(false);
  } finally {
    harness.close();
  }
});

test("Replay admissions do not duplicate developer log entries", async () => {
  const harness = harnessWithGate(() => true);
  try {
    let calls = 0;
    harness.runtime = createGuidedTurnRuntime({
      ...harness.dependencies,
      agent: {
        async run() {
          calls += 1;
          return { route: "direct", content: `replay 응답 ${calls}` };
        },
      },
    });
    const command = runCommand("devlog-replay-turn");
    await harness.runtime.runTurn(command);
    await harness.runtime.runTurn(command);

    expect(calls).toBe(1);
    expect(harness.store.list().total).toBe(1);
  } finally {
    harness.close();
  }
});

type Harness = {
  runtime: ReturnType<typeof createGuidedTurnRuntime>;
  store: DeveloperLogStore;
  dependencies: Omit<
    Parameters<typeof createGuidedTurnRuntime>[0],
    "agent"
  >;
  logPath: string;
  close: () => void;
};

function harnessWithGate(gate: () => boolean): Harness {
  const root = mkdtempSync(join(tmpdir(), "btcc-devlog-capture-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "btcc-devlog-capture",
    storageProfile: "ephemeral",
  });
  const store = new DeveloperLogStore({ butlerData: root });
  return {
    runtime: undefined as never,
    store,
    dependencies: {
      admission: stores.admission,
      turns: stores.turns,
      messages: stores.messages,
      developerLogCapture: createTurnDeveloperLogCapturePort({ store, gate }),
    },
    logPath: join(root, "app", "developer-logs", "model-turns.jsonl"),
    close() {
      stores.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function successAgent(content: string): GuidedTurnAgent {
  return {
    async run() {
      return { route: "direct", content };
    },
  };
}

function failingAgent(error: unknown): GuidedTurnAgent {
  return {
    async run() {
      throw error;
    },
  };
}

function runCommand(turnId: string): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-session",
    triggerKey: `message:${turnId}`,
    message: { messageId: `message:${turnId}`, content: "안녕" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/tmp"],
    },
  };
}

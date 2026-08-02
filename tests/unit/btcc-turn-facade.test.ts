import { expect, test } from "bun:test";
import { createBtcc } from
  "../../packages/butler-agent/src/agent/btcc/btcc.ts";
import type {
  BtccTurnRequest,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";
import type {
  BtccRunCommand,
  BtccStopCommand,
  BtccTurnPreparation,
  BtccTurnRuntime,
  FreshBtccTurnCommand,
  BtccTurnProgressObserver,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccCommittedProgressEvent } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { InMemoryBtccProgressEventRepository } from "./support/fake-btcc-gateway-runtime.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";

test("BTCC serializes different Turns in one session and deduplicates one in-flight Turn", async () => {
  const runtime = new DelayedRuntime();
  const { btcc, host } = createBtcc({
    runtime,
    preparation: preparation(),
    progressEvents: new InMemoryBtccProgressEventRepository(),
    turns: { findTurn: async () => null },
  });
  const first = request("session-1", "turn-1");
  const second = request("session-1", "turn-2");
  try {
    expect(Object.keys(btcc).sort()).toEqual(["runTurn", "stopTurn"]);
    expect("host" in btcc).toBe(false);
    const [firstResult, secondResult] = await Promise.all([
      btcc.runTurn(first),
      btcc.runTurn(second),
    ]);
    expect(firstResult.kind).toBe("delivered");
    expect(secondResult.kind).toBe("delivered");
    expect(runtime.calls).toEqual(["turn-1", "turn-2"]);

    runtime.calls.length = 0;
    const replay = request("session-1", "turn-dedupe");
    const [left, right] = await Promise.all([
      btcc.runTurn(replay),
      btcc.runTurn(replay),
    ]);
    expect(left).toEqual(right);
    expect(runtime.calls).toEqual(["turn-dedupe"]);
  } finally {
    await host.close();
  }
});

test("BTCC Stop fences an active Turn through the same public facade", async () => {
  const runtime = new DelayedRuntime();
  const progressEvents = new InMemoryBtccProgressEventRepository();
  const { btcc, host } = createBtcc({
    runtime,
    preparation: preparation(),
    progressEvents,
    turns: { findTurn: async (turnId) => turnId === "turn-stop" ? cancelledTurn(turnId) : null },
  });
  const requestForStop = request("session-stop", "turn-stop");
  try {
    const running = btcc.runTurn(requestForStop);
    await runtime.started;
    const stop = await btcc.stopTurn({ turnId: requestForStop.turnId });
    const outcome = await running;
    expect(stop.kind).toBe("cancelled");
    expect(outcome.kind).toBe("cancelled");
    expect(runtime.stopCalls).toEqual(["turn-stop"]);
    expect(progressEvents.forTurn("turn-stop")
      .filter((event) => event.event.kind === "turn.started"))
      .toHaveLength(0);
    expect(progressEvents.forTurn("turn-stop")
      .filter((event) => event.event.kind === "turn.cancelled"))
      .toHaveLength(1);
    const replay = await btcc.stopTurn({ turnId: requestForStop.turnId });
    expect(replay.kind).toBe("cancelled");
    expect(progressEvents.forTurn("turn-stop")
      .filter((event) => event.event.kind === "turn.cancelled"))
      .toHaveLength(1);
  } finally {
    await host.close();
  }
});

test("BTCC host replays pending progress across Turns without rerunning a Turn", async () => {
  const progressEvents = new InMemoryBtccProgressEventRepository();
  const recordedEvents: string[] = [];
  let fresh = true;
  const preparation: BtccTurnPreparation = {
    async prepare(input) {
      const isFresh = fresh;
      fresh = false;
      const command: BtccRunCommand = isFresh
        ? {
            kind: "run",
            turnId: input.turnId,
            sessionId: input.sessionId,
            triggerKey: input.eventId,
            message: { messageId: input.message.id, content: input.message.content },
            modelSelection: {
              provider: "fake",
              model: "fake",
              reasoningEffort: "none",
              controls: {},
              controlsHash: "fake",
            },
            context: {
              userRef: "fake",
              profileRefs: [],
              recentFeedbackRefs: [],
              mandatoryHotCacheRefs: [],
              optionalHotCacheRefs: [],
              baselineObservationScopeRefs: [],
            },
          }
        : { kind: "resume", turnId: input.turnId };
      return {
        command,
        isFresh,
        recordEvent(event) {
          recordedEvents.push(event.kind);
        },
        complete() {},
        cancel() {},
      };
    },
  };
  let rejectPublisher = true;
  const attempts: Array<{ eventId: string; actionId: string; published: boolean }> = [];
  const publisher = {
    async publish(event: import(
      "../../packages/butler-agent/src/agent/btcc/projection/index.ts"
    ).BtccCommittedProgressEvent): Promise<void> {
      expect(recordedEvents).toContain(event.event.kind);
      attempts.push({
        eventId: event.eventId,
        actionId: event.actionId,
        published: !rejectPublisher,
      });
      if (rejectPublisher) throw new Error("transport unavailable");
    },
  };

  const firstRuntime = new ProgressOnlyRuntime();
  const firstAssembly = createBtcc({
    runtime: firstRuntime,
    preparation,
    progressEvents,
    turns: { findTurn: async () => null },
  });
  const first = await firstAssembly.btcc.runTurn(request("session-progress", "turn-progress"));
  expect(first.kind).toBe("delivered");
  expect(progressEvents.pending("turn-progress")).not.toHaveLength(0);
  await firstAssembly.host.progress.reconcile(publisher);
  expect(progressEvents.pending()).not.toHaveLength(0);
  await firstAssembly.host.close();

  rejectPublisher = false;
  const secondRuntime = new ProgressOnlyRuntime();
  const secondAssembly = createBtcc({
    runtime: secondRuntime,
    preparation,
    progressEvents,
    turns: { findTurn: async () => null },
  });
  await secondAssembly.host.progress.reconcile(publisher);
  await secondAssembly.host.close();

  const committed = progressEvents.all();
  expect(secondRuntime.commands).toHaveLength(0);
  expect(committed.filter((event) => event.event.kind === "turn.started")).toHaveLength(1);
  expect(committed.every((event) => event.status === "published")).toBe(true);
  expect(committed.map((event) => event.turnSequence)).toEqual([1, 2, 3]);
  expect(committed.map((event) => event.sessionSequence)).toEqual([1, 2, 3]);
  expect(new Set(attempts.filter((attempt) => attempt.published).map((attempt) => attempt.eventId)).size)
    .toBe(committed.length);
  for (const event of committed) {
    expect(new Set(attempts.filter((attempt) => attempt.eventId === event.eventId)
      .map((attempt) => attempt.actionId))).toEqual(new Set([event.actionId]));
  }
  expect(firstRuntime.commands.map((command) => command.kind)).toEqual(["run"]);
  expect(secondRuntime.commands).toHaveLength(0);
});

function cancelledTurn(turnId: string): TurnRecord {
  return {
    turnId,
    sessionId: "session-stop",
    inboxId: `inbox-${turnId}`,
    triggerKey: `trigger-${turnId}`,
    originalMessageId: `message-${turnId}`,
    originalMessage: "stop this",
    progressDestination: {
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      replyToMessageId: `message-${turnId}`,
    },
    modelSelection: {
      provider: "fake",
      model: "fake",
      reasoningEffort: "none",
      controls: {},
      controlsHash: "fake",
    },
    context: {
      userRef: "fake",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
    semanticState: "cancelled",
    revision: 1,
    executionFence: 1,
    finalDisposition: "cancelled",
  };
}

function preparation(): BtccTurnPreparation {
  return {
    async prepare(input) {
      const command: FreshBtccTurnCommand = {
        kind: "run",
        turnId: input.turnId,
        sessionId: input.sessionId,
        triggerKey: input.eventId,
        message: {
          messageId: input.message.id,
          content: input.message.content,
        },
        modelSelection: {
          provider: "fake",
          model: "fake",
          reasoningEffort: "none",
          controls: {},
          controlsHash: "fake",
        },
        context: {
          userRef: "fake",
          profileRefs: [],
          recentFeedbackRefs: [],
          mandatoryHotCacheRefs: [],
          optionalHotCacheRefs: [],
          baselineObservationScopeRefs: [],
        },
      };
      return {
        command,
        isFresh: true,
        recordEvent() {},
        complete() {},
        cancel() {},
      };
    },
  };
}

class DelayedRuntime implements BtccTurnRuntime {
  readonly calls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private stopped = new Map<string, (outcome: BtccRuntimeOutcome) => void>();

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  async runTurn(
    command: BtccRunCommand,
    _progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccRuntimeOutcome> {
    this.calls.push(command.turnId);
    await onAdmitted?.(command.kind !== "resume");
    this.resolveStarted();
    if (command.turnId === "turn-stop") {
      return await new Promise((resolve) => this.stopped.set(command.turnId, resolve));
    }
    if (command.turnId === "turn-1") await Bun.sleep(10);
    return {
      kind: "delivered",
      turnId: command.turnId,
      messageId: `message:${command.turnId}`,
      content: `answer:${command.turnId}`,
    };
  }

  async stopTurn(command: BtccStopCommand): Promise<BtccRuntimeOutcome> {
    this.stopCalls.push(command.turnId);
    const outcome: BtccRuntimeOutcome = {
      kind: "cancelled",
      turnId: command.turnId,
    };
    this.stopped.get(command.turnId)?.(outcome);
    return outcome;
  }
}

type BtccRuntimeOutcome =
  | { kind: "delivered"; turnId: string; messageId: string; content: string }
  | { kind: "cancelled"; turnId: string };

class ProgressOnlyRuntime implements BtccTurnRuntime {
  readonly commands: BtccRunCommand[] = [];

  async runTurn(
    command: BtccRunCommand,
    progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccRuntimeOutcome | { kind: "already_delivered"; turnId: string; messageId: string; content: string }> {
    this.commands.push(command);
    await onAdmitted?.(command.kind !== "resume");
    if (command.kind === "resume") {
      return {
        kind: "already_delivered",
        turnId: command.turnId,
        messageId: "assistant:progress",
        content: "stored progress answer",
      };
    }
    await progress?.stateChanged({
      turnId: command.turnId,
      semanticState: "delivery_committed",
      turnRevision: 2,
    });
    await progress?.stateChanged({
      turnId: command.turnId,
      semanticState: "delivered",
      turnRevision: 3,
    });
    return {
      kind: "delivered",
      turnId: command.turnId,
      messageId: "assistant:progress",
      content: "progress answer",
    };
  }

  async stopTurn(command: BtccStopCommand): Promise<BtccRuntimeOutcome> {
    return { kind: "cancelled", turnId: command.turnId };
  }
}

function request(sessionId: string, turnId: string): BtccTurnRequest {
  return {
    turnId,
    sessionId,
    eventId: `event:${turnId}`,
    transport: "test",
    accountId: "test",
    peer: { kind: "dm", id: sessionId },
    sender: { id: "test" },
    message: {
      id: `message:${turnId}`,
      content: `request:${turnId}`,
      timestamp: "2026-08-03T00:00:00.000Z",
    },
    trigger: { kind: "user_message" },
    route: {
      role: "butler",
      workspacePath: "/tmp/butler-test",
    },
  };
}

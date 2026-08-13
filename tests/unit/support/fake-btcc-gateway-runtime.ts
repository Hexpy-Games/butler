import type {
  Btcc,
  BtccTurnRequest,
  BtccTurnOutcome,
} from "../../../packages/butler-agent/src/agent/btcc/index.ts";
import type {
  BtccRunCommand,
  BtccStopCommand,
  BtccTurnProgressObserver,
  BtccWakeAuthorization,
} from "../../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type {
  BtccCommittedProgressEvent,
  BtccProgressEventRepository,
  BtccWakeCompletionCandidate,
} from "../../../packages/butler-agent/src/agent/btcc/projection/index.ts";

type BtccTurnCommand = BtccRunCommand | BtccStopCommand;

export type BtccTestHost = {
  progress: {
    hasCommittedEvent(turnId: string, kind: string): boolean;
    reconcile(publisher: {
      publish(event: BtccCommittedProgressEvent): Promise<void> | void;
    }): Promise<{ attempted: number; published: number; pending: number }>;
  };
  wake?: {
    reconcile(candidates: readonly BtccWakeCompletionCandidate[]): Promise<{
      candidates: number;
      authorized: number;
      rejected: number;
      dispatched: number;
      pending: number;
    }>;
  };
  close(): void;
};

export class ScriptedBtccGatewayRuntime implements Btcc {
  readonly commands: BtccTurnCommand[] = [];
  readonly persistedContextDocuments = new Map<string, Record<string, unknown>>();
  readonly contextDocuments = {
    persist: (input: { scopeKind: string; scopeId: string; sourceId: string }) => {
      const ref = `context:${input.scopeKind}:${input.scopeId}:${input.sourceId}`;
      this.persistedContextDocuments.set(ref, input);
      return ref;
    },
  };
  readonly progressEvents = new InMemoryBtccProgressEventRepository();
  readonly wakeAuthorizations = new InMemoryBtccWakeAuthorizationRepository();
  protected readonly sessionByTurn = new Map<string, string>();
  readonly runtime = {
    runTurn: (
      command: BtccRunCommand,
      progress?: BtccTurnProgressObserver,
      onAdmitted?: (isFresh: boolean) => void | Promise<void>,
    ) => this.handle(command, progress, onAdmitted),
    stopTurn: (command: BtccStopCommand) => this.handle(command),
  };

  constructor(private readonly answer: string | ((command: BtccTurnCommand) => string)) {}

  close(): void {}

  runTurn(request: BtccTurnRequest): Promise<BtccTurnOutcome> {
    return this.handle(commandFromRequest(request));
  }

  stopTurn(request: { turnId: string }): Promise<BtccTurnOutcome> {
    return this.handle({ kind: "stop", turnId: request.turnId }).then((outcome) => {
      if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
        const sessionId = this.sessionByTurn.get(request.turnId) ?? "general";
        const appChatId = sessionId.startsWith("butler/app-")
          ? sessionId.slice("butler/app-".length)
          : sessionId;
        this.progressEvents.append({
          sessionId,
          turnId: request.turnId,
          destination: {
            transport: "app",
            accountId: "local",
            peer: { kind: "dm", id: appChatId },
            replyToMessageId: request.turnId,
          },
          event: { kind: "turn.cancelled" },
        });
      }
      return outcome;
    });
  }

  protected async handle(
    command: BtccTurnCommand,
    progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccTurnOutcome> {
    this.commands.push(command);
    if (command.kind === "stop") return { kind: "cancelled", turnId: command.turnId };
    if (command.kind !== "resume") {
      this.sessionByTurn.set(command.turnId, command.sessionId);
    }
    await onAdmitted?.(command.kind !== "resume");
    const text = typeof this.answer === "function" ? this.answer(command) : this.answer;
    await progress?.stateChanged({
      turnId: command.turnId,
      semanticState: "reporting",
      turnRevision: 1,
    });
    await progress?.stateChanged({
      turnId: command.turnId,
      semanticState: "delivered",
      turnRevision: 2,
    });
    return {
      kind: "delivered",
      turnId: command.turnId,
      messageId: `assistant:${command.turnId}`,
      content: text,
    };
  }

}

export function createBtccTestHost(
  runtime: Pick<ScriptedBtccGatewayRuntime, "progressEvents">,
): BtccTestHost {
  return {
    progress: {
      hasCommittedEvent: (turnId, kind) => runtime.progressEvents.forTurn(turnId)
        .some((event) => event.event.kind === kind),
      reconcile: async (publisher) => {
        const pending = runtime.progressEvents.pending();
        let published = 0;
        for (const event of pending) {
          try {
            await publisher.publish(event);
            runtime.progressEvents.markPublished(event.eventId);
            published += 1;
          } catch {
            // test host keeps failed events pending
          }
        }
        return {
          attempted: pending.length,
          published,
          pending: runtime.progressEvents.pending().length,
        };
      },
    },
    close: () => {},
  };
}

function commandFromRequest(request: BtccTurnRequest): BtccRunCommand {
  if (request.trigger.kind === "authorized_wake") {
    return {
      kind: "wake",
      turnId: request.turnId,
      sessionId: request.sessionId,
      triggerKey: request.eventId,
      trigger: {
        triggerId: request.trigger.triggerId,
        sourceTurnId: request.trigger.sourceTurnId,
        authorizationRef: request.trigger.authorizationRef,
        ...(request.trigger.resultScopeRef
          ? { resultScopeRef: request.trigger.resultScopeRef }
          : {}),
        content: request.message.content,
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
  }
  return {
    kind: "run",
    turnId: request.turnId,
    sessionId: request.sessionId,
    triggerKey: request.eventId,
    message: {
      messageId: request.message.id,
      content: request.message.content,
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
}

export class StoppableBtccGatewayRuntime extends ScriptedBtccGatewayRuntime {
  stopped = false;
  private resolveStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private resolveRun: ((outcome: BtccTurnOutcome) => void) | undefined;

  constructor() {
    super("");
  }

  protected override async handle(
    command: BtccTurnCommand,
    _progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccTurnOutcome> {
    this.commands.push(command);
    if (command.kind === "stop") {
      this.stopped = true;
      const outcome = { kind: "cancelled", turnId: command.turnId } as const;
      this.resolveRun?.(outcome);
      return outcome;
    }
    if (command.kind !== "resume") {
      this.sessionByTurn.set(command.turnId, command.sessionId);
    }
    await onAdmitted?.(command.kind !== "resume");
    this.resolveStarted?.();
    return await new Promise<BtccTurnOutcome>((resolve) => {
      this.resolveRun = resolve;
    });
  }
}

export class InMemoryBtccProgressEventRepository implements BtccProgressEventRepository {
  private readonly events: BtccCommittedProgressEvent[] = [];
  private readonly fingerprints = new Map<string, string>();

  append(input: Parameters<BtccProgressEventRepository["append"]>[0]): BtccCommittedProgressEvent {
    const event = {
      ...input.event,
      visibility: input.event.visibility ?? "public",
    };
    const fingerprint = JSON.stringify({
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload ?? {},
    });
    const existing = this.events.find((candidate) =>
      candidate.turnId === input.turnId &&
      this.fingerprints.get(candidate.eventId) === fingerprint,
    );
    if (existing) return existing;
    const eventId = `test-progress:${input.turnId}:${this.events.length + 1}`;
    const committed: BtccCommittedProgressEvent = {
      eventId,
      actionId: `test-action:${eventId}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sessionSequence: this.events.filter((candidate) => candidate.sessionId === input.sessionId).length + 1,
      turnSequence: this.events.filter((candidate) => candidate.turnId === input.turnId).length + 1,
      event,
      destination: input.destination,
      status: "pending",
    };
    this.events.push(committed);
    this.fingerprints.set(eventId, fingerprint);
    return committed;
  }

  pending(turnId?: string): BtccCommittedProgressEvent[] {
    return this.events
      .filter((event) => (!turnId || event.turnId === turnId) && event.status === "pending")
      .sort((left, right) => turnId
        ? left.turnSequence - right.turnSequence
        : left.sessionSequence - right.sessionSequence);
  }

  forTurn(turnId: string): BtccCommittedProgressEvent[] {
    return this.events
      .filter((event) => event.turnId === turnId)
      .sort((left, right) => left.turnSequence - right.turnSequence);
  }

  all(): BtccCommittedProgressEvent[] {
    return [...this.events];
  }

  markPublished(eventId: string): void {
    const event = this.events.find((candidate) => candidate.eventId === eventId);
    if (event) event.status = "published";
  }
}

export class InMemoryBtccWakeAuthorizationRepository {
  private readonly facts = new Set<string>();

  recordAuthorization(input: BtccWakeAuthorization): void {
    this.facts.add(wakeFactKey(input));
  }

  validateWake(input: BtccWakeAuthorization): boolean {
    return this.facts.has(wakeFactKey(input));
  }

  clear(): void {
    this.facts.clear();
  }
}

function wakeFactKey(input: BtccWakeAuthorization): string {
  return [input.sourceTurnId, input.authorizationRef, input.resultScopeRef ?? ""].join("\0");
}

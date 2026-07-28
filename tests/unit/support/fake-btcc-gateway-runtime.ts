import type {
  BtccTurnCommand,
  BtccTurnOutcome,
} from "../../../packages/butler-agent/src/agent/btcc/index.ts";
import type { BtccTurnProgressObserver } from "../../../packages/butler-agent/src/agent/btcc/index.ts";
import type { BtccGatewayRuntime } from "../../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";

export class ScriptedBtccGatewayRuntime implements BtccGatewayRuntime {
  readonly commands: BtccTurnCommand[] = [];
  readonly persistedContextDocuments = new Map<string, Record<string, unknown>>();
  readonly contextDocuments = {
    persist: (input: { scopeKind: string; scopeId: string; sourceId: string }) => {
      const ref = `context:${input.scopeKind}:${input.scopeId}:${input.sourceId}`;
      this.persistedContextDocuments.set(ref, input);
      return ref;
    },
  };
  readonly runtime = {
    runTurn: (command: Exclude<BtccTurnCommand, { kind: "stop" }>) =>
      this.handle(command),
    stopTurn: (command: Extract<BtccTurnCommand, { kind: "stop" }>) =>
      this.handle(command),
  };
  private readonly observers = new Map<string, Set<BtccTurnProgressObserver>>();

  constructor(private readonly answer: string | ((command: BtccTurnCommand) => string)) {}

  observeTurn(turnId: string, observer: BtccTurnProgressObserver): () => void {
    const observers = this.observers.get(turnId) ?? new Set();
    observers.add(observer);
    this.observers.set(turnId, observers);
    return () => observers.delete(observer);
  }

  close(): void {}

  protected async handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    this.commands.push(command);
    if (command.kind === "stop") return { kind: "cancelled", turnId: command.turnId };
    const text = typeof this.answer === "function" ? this.answer(command) : this.answer;
    await this.publish(command.turnId, "reporting", 1);
    await this.publish(command.turnId, "delivered", 2);
    return {
      kind: "delivered",
      turnId: command.turnId,
      messageId: `assistant:${command.turnId}`,
      content: text,
    };
  }

  protected async publish(turnId: string, semanticState: string, turnRevision: number) {
    for (const observer of this.observers.get(turnId) ?? []) {
      await observer.stateChanged({ turnId, semanticState, turnRevision });
    }
  }
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

  protected override async handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    this.commands.push(command);
    if (command.kind === "stop") {
      this.stopped = true;
      const outcome = { kind: "cancelled", turnId: command.turnId } as const;
      this.resolveRun?.(outcome);
      return outcome;
    }
    this.resolveStarted?.();
    return await new Promise<BtccTurnOutcome>((resolve) => {
      this.resolveRun = resolve;
    });
  }
}

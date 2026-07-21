import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
} from "../contracts.ts";
import { admitTurn } from "./admission/index.ts";
import type { TurnRecord } from "./contracts.ts";

export type ContinuingTurnCommand = Exclude<BtccTurnCommand, { kind: "stop" }>;

export async function loadOrAdmitTurn(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  const existing = await dependencies.turns.findTurn(command.turnId);
  if (existing) {
    if (command.kind !== "resume") assertExactFreshReplay(existing, command);
    return existing;
  }
  if (command.kind === "resume") {
    throw new Error(`BTCC Turn is not admitted: ${command.turnId}`);
  }
  return admitTurn(command, dependencies.admission, dependencies.turns);
}

function assertExactFreshReplay(
  turn: TurnRecord,
  command: Extract<BtccTurnCommand, { kind: "run" | "wake" }>,
): void {
  const source = command.kind === "run"
    ? command.message
    : { messageId: command.trigger.triggerId, content: command.trigger.content };
  if (
    turn.sessionId !== command.sessionId ||
    turn.triggerKey !== command.triggerKey ||
    turn.originalMessageId !== source.messageId ||
    turn.originalMessage !== source.content ||
    canonicalJson(turn.modelSelection) !== canonicalJson(command.modelSelection) ||
    canonicalJson(turn.context) !== canonicalJson(command.context)
  ) {
    throw new Error(`BTCC run replay does not match admitted Turn: ${turn.turnId}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

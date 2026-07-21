import type {
  PhaseConversationCommand,
  PhaseEnvelope,
} from "./contracts.ts";

export async function runPhaseConversation<Product>(
  command: PhaseConversationCommand<Product>,
): Promise<Product> {
  const accepted = await command.store.loadAcceptedProduct<Product>(command.binding);
  if (accepted) return accepted;

  const envelope: PhaseEnvelope = {
    binding: command.binding,
    ...command.phaseContract,
    modelSelection: command.modelSelection,
    context: command.context,
  };
  const round = await command.model.runRound(envelope);
  if (round.kind === "interruption") {
    throw new Error(`BTCC operational interruption: ${round.code}`);
  }
  assertActualModel(command.modelSelection, round.actualIdentity);
  const product = command.codec.decode(round.submission, envelope);
  await command.store.persistAcceptedProduct({
    binding: command.binding,
    product,
    actualIdentity: round.actualIdentity,
  });
  return product;
}

function assertActualModel(
  expected: PhaseConversationCommand<unknown>["modelSelection"],
  actual: {
    provider: string;
    model: string;
    reasoningEffort: string;
    controlsHash: string;
  },
): void {
  if (
    actual.provider !== expected.provider ||
    actual.model !== expected.model ||
    actual.reasoningEffort !== expected.reasoningEffort ||
    actual.controlsHash !== expected.controlsHash
  ) {
    throw new Error("BTCC selected model identity mismatch");
  }
}

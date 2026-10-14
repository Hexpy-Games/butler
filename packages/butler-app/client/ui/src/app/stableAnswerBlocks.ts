import type { AnswerBlockSet } from "../../../shared/app-contracts";
import type { MessageRecord } from "./types";

// Snapshots are immutable. Cache the raw wire-spec serialization, not a second
// parsed tree or a hash with possible collisions. Weak keys retain no history.
const signatures = new WeakMap<AnswerBlockSet[], string>();

function signature(sets: AnswerBlockSet[]): string {
  let value = signatures.get(sets);
  if (value === undefined) {
    value = JSON.stringify(sets);
    signatures.set(sets, value);
  }
  return value;
}

/** Text snapshots keep the parsed/rendered subtree; changed metadata and specs still propagate. */
export function retainAnswerBlocks(previous: MessageRecord | undefined, incoming: MessageRecord): MessageRecord {
  const before = previous?.answer_blocks;
  const after = incoming.answer_blocks;
  if (!before || !after || before === after || before.length !== after.length) return incoming;
  return signature(before) === signature(after) ? { ...incoming, answer_blocks: before } : incoming;
}

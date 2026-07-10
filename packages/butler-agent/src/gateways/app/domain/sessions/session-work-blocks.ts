import { projectSharedWorkBlocks } from "../../../../agent/events/progress-projection.ts";
import type {
  ProgressSummaryRow,
  WorkerActivityWorkBlock,
} from "../../interface/protocol/app-protocol.ts";

export function workBlocksFromTerminalProgressRows(
  rows: ProgressSummaryRow[],
): WorkerActivityWorkBlock[] {
  return projectSharedWorkBlocks(rows).blocks;
}

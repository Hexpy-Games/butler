import type { ProgressRow } from "@/app/types.ts";
import { CurrentStatusText } from "./CurrentStatusText";

export function CurrentPhaseActivity({ row }: { row: ProgressRow }) {
  return (
    <CurrentStatusText row={row} testClass="turn-phase-activity" />
  );
}

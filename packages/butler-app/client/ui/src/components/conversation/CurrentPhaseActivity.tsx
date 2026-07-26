import type { ProgressRow } from "@/app/types.ts";
import { Typo } from "@/butler-ds";

const secondaryText = {
  color: "var(--text-secondary)",
  minWidth: 0,
  overflowWrap: "anywhere",
} as const;

export function CurrentPhaseActivity({ row }: { row: ProgressRow }) {
  return (
    <Typo.Body
      as="p"
      data-test-class="turn-phase-activity"
      data-turn-state={row.state}
      style={secondaryText}
    >
      {row.safe_label}
    </Typo.Body>
  );
}

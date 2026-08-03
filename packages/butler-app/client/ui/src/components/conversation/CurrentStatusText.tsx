import type { ProgressRow } from "@/app/types.ts";
import { Typo } from "@/butler-ds";

const currentStatusTextStyle = {
  color: "var(--text-secondary)",
  minWidth: 0,
  overflowWrap: "anywhere",
} as const;

export function CurrentStatusText({
  row,
  label,
  suffix,
  testClass,
  ariaLabel,
}: {
  row: ProgressRow;
  label?: string;
  suffix?: string;
  testClass: string;
  ariaLabel?: string;
}) {
  return (
    <Typo.Body
      aria-label={ariaLabel}
      as="p"
      data-test-class={testClass}
      data-turn-state={row.state}
      style={currentStatusTextStyle}
    >
      {label ?? row.safe_label}
      {suffix ? ` · ${suffix}` : ""}
    </Typo.Body>
  );
}

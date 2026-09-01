import type { DurableWorkActionProgress } from "../../../btcc/work/index.ts";

export function sameActionKeys(
  earlier: DurableWorkActionProgress[] | undefined,
  later: DurableWorkActionProgress[] | undefined,
): boolean {
  if (!earlier || !later || earlier.length !== later.length) return false;
  return earlier.every(
    (action, index) => later[index]?.actionKey === action.actionKey,
  );
}

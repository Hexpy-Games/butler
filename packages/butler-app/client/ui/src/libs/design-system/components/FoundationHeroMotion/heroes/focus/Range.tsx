import { SegmentedControl } from "../../../SegmentedControl";
import type { FocusCopy } from "./focusCopy";
import { Named } from "./Named";
import { RANGE } from "./FocusScenes";

/** The range picker (a roving radio group) with one value selected: the hero cuts between them as arrows move the selection. */
export function Range({ copy, value, named = false }: { copy: FocusCopy; value: string; named?: boolean }) {
  const labels = { day: copy.day, week: copy.week, month: copy.month };
  const control = <SegmentedControl ariaLabel={copy.range} onValueChange={() => undefined} value={value} options={RANGE.map((id) => ({ value: id, label: labels[id] }))} />;
  if (!named) return control;
  return <Named names={Object.fromEntries(RANGE.map((id, k) => [`g${k}`, `[role="radio"]:nth-of-type(${k + 1})`]))}>{control}</Named>;
}

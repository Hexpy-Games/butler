import { SegmentedControl } from "../../../SegmentedControl";
import { type RadiusCopy } from "./radiusCopy";
import { Level } from "./Level";
import s from "./RadiusHero.module.css";

/** Scene 5: a control you press: the chosen segment rises off its track on --shadow-control (the real SegmentedControl, before and after). */
export function PressScene({ copy }: { copy: RadiusCopy }) {
  const options = [{ value: "day", label: copy.day }, { value: "week", label: copy.week }, { value: "month", label: copy.month }];
  const noop = () => undefined;
  return (
    <Level copy={copy} k={0}>
      <span className={s.swap}>
        <span data-t="px-0"><SegmentedControl ariaLabel={copy.period} onValueChange={noop} options={options} value="day" /></span>
        <span data-t="px-1"><SegmentedControl ariaLabel={copy.period} onValueChange={noop} options={options} value="week" /></span>
      </span>
    </Level>
  );
}

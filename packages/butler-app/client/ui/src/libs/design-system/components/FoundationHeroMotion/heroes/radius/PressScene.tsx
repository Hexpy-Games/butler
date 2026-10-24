import { Switch } from "../../../Switch";
import { type RadiusCopy } from "./radiusCopy";
import { Level } from "./Level";
import s from "./RadiusHero.module.css";

/** Scene 5: a control you press: the switch's thumb rides on --shadow-control (the real Switch, before and after). */
export function PressScene({ copy }: { copy: RadiusCopy }) {
  const noop = () => undefined;
  return (
    <Level copy={copy} k={0}>
      <span className={s.swap}>
        <span data-t="px-0"><Switch aria-label={copy.notify} checked={false} onCheckedChange={noop} /></span>
        <span data-t="px-1"><Switch aria-label={copy.notify} checked onCheckedChange={noop} /></span>
      </span>
    </Level>
  );
}

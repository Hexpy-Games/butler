import { cn } from "../../../lib/utils";
import { slotStyle } from "../heroSequence";
import s from "../FoundationHeroMotion.module.css";
import v from "../heroVariants.module.css";
import { HeroReadout } from "./HeroReadout";

const FOCUS_CONTROLS = ["field", "button", "switch", "icon"] as const;
/** The DS component each shape stands for, in tab order. */
const NAMES = ["Input", "Button", "Switch", "IconButton"];
const AWAY = "translateX(calc(var(--motion-distance-md) * -1))";
const TOWARD = "translateX(var(--motion-distance-md))";

/** 07 Focus ring: the one accent ring moves through the tab order, arriving from the control it left. */
export function FocusHero() {
  const last = FOCUS_CONTROLS.length - 1;
  return (
    <>
    <span className={v.focusRow}>
      {FOCUS_CONTROLS.map((kind, k) => (
        <span className={v.focusControl} data-kind={kind} key={kind}>
          {kind === "switch" ? <span className={v.switchThumb} /> : null}
          {kind === "field" ? <span className={v.fieldText} /> : null}
          {kind === "button" ? <span className={v.primaryText} /> : null}
          {kind === "icon" ? <span className={v.iconGlyph} /> : null}
          <span className={cn(s.slot, v.ring)} data-slots={4} data-poster={k === 0 ? "" : undefined}
            style={slotStyle(4, k, { from: k === 0 ? TOWARD : AWAY, to: k === last ? AWAY : TOWARD })} />
        </span>
      ))}
    </span>
    <HeroReadout slots={4} items={NAMES.map((name, k) => `:focus-visible · ${k + 1}/${NAMES.length} ${name}`)} />
    </>
  );
}

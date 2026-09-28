import { cn } from "../../../lib/utils";
import { pingPong, slotStyle } from "../heroSequence";
import s from "../FoundationHeroMotion.module.css";
import v from "../heroVariants.module.css";

/** Radius role and the shadow that surface carries. */
const SURFACES = [["control", "control"], ["panel", "card"], ["popover", "card"], ["composer", "window"]] as const;
const SURFACE_ORDER = pingPong(SURFACES.length);
const lift = (level: number) => `translateY(calc(var(--space-md) * ${-level}))`;

/** 05 Radius and elevation: one surface lifts through the shadow levels as its corners grow. */
export function RadiusHero() {
  return (
    <span className={v.stack}>
      {SURFACE_ORDER.map((level, k) => {
        const previous = SURFACE_ORDER[(k - 1 + SURFACE_ORDER.length) % SURFACE_ORDER.length]!;
        const next = SURFACE_ORDER[(k + 1) % SURFACE_ORDER.length]!;
        const [radius, shadow] = SURFACES[level]!;
        return (
          <span className={cn(s.slot, v.surface)} data-slots={6} data-poster={k === 2 ? "" : undefined} key={k}
            style={slotStyle(6, k, { from: lift(previous), rest: lift(level), to: lift(next) }, {
              "--surface-radius": `var(--radius-${radius})`,
              "--surface-shadow": `var(--shadow-${shadow})`,
            })}>
            <span className={v.surfaceAvatar} />
            <span className={v.surfaceLines}><span /><span /></span>
          </span>
        );
      })}
    </span>
  );
}

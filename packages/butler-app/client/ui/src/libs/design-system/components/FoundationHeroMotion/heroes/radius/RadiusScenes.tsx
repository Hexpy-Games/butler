import type { CSSProperties } from "react";
import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Annotations } from "../shared/Annotations";
import { openingItems } from "../shared/guides";
import { valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import type { Annot, Geometry } from "../shared/types";
import { LEVELS, RADII, type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** The nested surfaces, outermost first, with the radius each takes. */
export const NEST = [
  { n: "n-window", level: "window", token: "--radius-composer" }, { n: "n-popover", level: "popover", token: "--radius-popover" },
  { n: "n-card", level: "card", token: "--radius-panel" }, { n: "n-button", level: "button", token: "--radius-control" },
] as const;

export const NEST_ANNOTS: Annot[] = NEST.map(({ n, token }) => ({ kind: "radius", target: n, label: valueLabel(token, true) }));

/** The shadows' offset and blur guides (the tiles' names already say which shadow). */
export const SHADOW_ANNOTS: Annot[] = LEVELS.map((_, k) => ({ kind: "shadow", target: `sh-${k}` }));

function nested(depth: number) {
  const box = NEST[depth];
  if (!box) return null;
  return (
    <Mark block n={box.n}>
      <div className={s.nBox} data-level={box.level}>
        <span className={s.nOutline} data-t={`nb-${depth}`} />
        {nested(depth + 1)}
      </div>
    </Mark>
  );
}

/**
 * Scene 2 and 3, left of the poster: one square morphs its corners through
 * the radius ladder (a circle rides the corner, the value rolls), then four
 * surfaces nest, their corners growing outward.
 */
export function RadiusLab({ g }: { g: Geometry | null }) {
  return (
    <div className={s.lab} data-t="lab">
      <div className={s.labStage} data-m="lab">
        <div className={s.morph}>
          <div className={s.shapeStack}>
            {RADII.map((r, k) => (
              <span className={s.shape} data-t={`mo-${k}`} key={r.token} style={{ "--r": `var(${r.token})` } as CSSProperties}><span className={s.cornerGuide} /></span>
            ))}
          </div>
          <div className={s.morphRead}>
            <R name="mt-rv"><span className={s.tokenStack}>{RADII.map((r, k) => <span className={s.tokenLayer} data-t={`mt-${k}`} key={r.token}>{r.token}</span>)}</span></R>
            <Roller className={s.bigRead} id="mr" poster={0} values={RADII.map((r) => r.value)} />
          </div>
        </div>
        <div className={s.nest} data-mark-scope="nest">
          {nested(0)}
          {g ? <Annotations items={openingItems(NEST_ANNOTS, g.scopes.nest ?? {}, "n", g.layout)} shown /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The token field: the radius ladder as corner tiles, and the three
 * elevations as real surface panels that lift off their flat copies, their
 * shadow's offset and blur drawn under them.
 */
export function RadiusField({ g, copy }: { g: Geometry | null; copy: RadiusCopy }) {
  const names = { low: copy.low, medium: copy.medium, high: copy.high };
  return (
    <div className={s.field} data-m="field">
      <div className={s.radii}>
        {RADII.map((r, k) => (
          <div className={s.cell} key={r.token}>
            <span className={s.tile} data-t={`lt-${k}`} style={{ "--r": `var(${r.token})` } as CSSProperties} />
            <span className={s.name}><R name={`lt-n${k}`}>{r.token}</R></span>
          </div>
        ))}
      </div>
      <div className={s.levels} data-mark-scope="ladder">
        {LEVELS.map((level, k) => (
          <div className={s.cell} key={level.token}>
            <span className={s.lift}>
              <span className={s.flat} data-t={`lf-${k}`}><SurfacePanel elevation="none"><span className={s.levelLabel}><R name={`lv-l${k}`}>{names[level.elevation]}</R></span></SurfacePanel></span>
              <Mark n={`sh-${k}`}><span className={s.lifted} data-t={`lu-${k}`}><SurfacePanel elevation={level.elevation}><span className={s.levelLabel}><R name={`lv-l${k}`}>{names[level.elevation]}</R></span></SurfacePanel></span></Mark>
            </span>
            <span className={s.name}><R name={`lv-n${k}`}>{level.token}</R></span>
          </div>
        ))}
        {g ? <Annotations items={openingItems(SHADOW_ANNOTS, g.scopes.ladder ?? {}, "s", g.layout)} /> : null}
      </div>
    </div>
  );
}

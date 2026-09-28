import { Settings } from "../../../Icons";
import type { HeroLayout } from "../shared/grid";
import { Roller } from "../shared/Roller";
import { STEPS, type IconCopy } from "./iconCopy";
import { IconGrid, Keyline, SidebarCrop, roleText } from "./iconParts";
import s from "./IconHero.module.css";

/** The title's touch: the "o" is a glyph's circle on its keyline square, stroked on. */
export function TitleWord({ title }: { title: string }) {
  const at = title.indexOf("o");
  if (at < 0) return <span>{title}</span>;
  return (
    <span className={s.titleWord}>
      {title.slice(0, at)}
      <span className={s.titleO}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect className={s.titleKey} data-t="to-k" height="22" width="22" x="1" y="1" />
          <circle className={s.titleCircle} cx="12" cy="12" data-t="to-c" pathLength={100} r="8.6" />
        </svg>
      </span>
      {title.slice(at + 1)}
    </span>
  );
}

/** Scene 2: the gear on its keyline grid, drawn stroke by stroke; three notes on three sides. */
export function GlyphScene({ copy }: { copy: IconCopy }) {
  return <div className={s.glyphStage} data-m="glyph"><Keyline copy={copy} /></div>;
}

/**
 * Scene 3 (signature): one label row steps through five roles; the icon
 * swaps its named size in lockstep on a centre line that never moves. The
 * readouts (role, size token, px) stand beside the row (below it on the
 * phone), clear of the widest step.
 */
export function GrowScene({ copy }: { copy: IconCopy }) {
  const last = STEPS.length - 1;
  return (
    <div className={s.growStage} data-m="grow">
      <span className={s.growRow}>
        <span className={s.growLine} data-t="gr-line" />
        <span className={s.layers}>{STEPS.map((step, k) => <span className={s.layer} data-t={`gi-${k}`} key={step.icon}><Settings size={step.icon} /></span>)}</span>
        <span className={s.layers}>{STEPS.map((step, k) => <span className={s.layer} data-t={`gt-${k}`} key={step.role}>{roleText(step.role, copy.settings)}</span>)}</span>
      </span>
      <span className={s.growRead}>
        <Cuts className={s.readRole} name="grr" values={STEPS.map((step) => step.role)} />
        <Cuts className={s.readToken} name="grn" values={STEPS.map((step) => `--icon-size-${step.icon}`)} />
        <Roller className={s.bigValue} id="grp" poster={last} values={STEPS.map((step) => String(step.px))} />
      </span>
    </div>
  );
}

/** A readout that cuts between its values in place, left-aligned (the timeline shows one at a time). */
function Cuts({ name, values, className }: { name: string; values: string[]; className?: string }) {
  return <span className={`${s.cuts} ${className ?? ""}`}>{values.map((value, k) => <span className={s.cutLayer} data-t={`${name}-${k}`} key={value}>{value}</span>)}</span>;
}

/** Scenes 4–5: the app's sidebar; its icons pop in row by row, then a click on Settings. */
export function PlaceScene({ copy }: { copy: IconCopy }) {
  return <div className={s.placeStage} data-m="place"><SidebarCrop copy={copy} /></div>;
}

/** Scene 6, the finale and the poster: the icon set filling the frame. */
export function GridScene({ layout }: { layout: HeroLayout }) {
  return <IconGrid layout={layout} />;
}

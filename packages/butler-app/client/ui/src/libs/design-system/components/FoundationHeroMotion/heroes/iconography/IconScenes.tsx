import { Settings } from "../../../Icons";
import { Roller } from "../shared/Roller";
import { STEPS, type IconCopy } from "./iconCopy";
import { Keyline, Sidebar, roleText } from "./iconTiles";
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
  return <div className={s.glyphStage} data-m="glyph"><Keyline copy={copy} name="kl" /></div>;
}

/** Scene 3 (signature): one label row steps through five roles; the icon swaps its named size in lockstep on a fixed centre line. */
export function GrowScene({ copy }: { copy: IconCopy }) {
  const last = STEPS.length - 1;
  return (
    <div className={s.growStage} data-m="grow">
      <span className={s.growRow}>
        <span className={s.growLine} />
        <span className={s.layers}>{STEPS.map((step, k) => <span className={s.layer} data-t={`gi-${k}`} key={step.icon}><Settings size={step.icon} /></span>)}</span>
        <span className={s.layers}>{STEPS.map((step, k) => <span className={s.layer} data-t={`gt-${k}`} key={step.role}>{roleText(step.role, copy.settings)}</span>)}</span>
      </span>
      <span className={s.growRead}>
        <span className={s.readRole}><Roller id="grr" poster={last} values={STEPS.map((step) => step.role)} /></span>
        <span className={s.readToken}>--icon-size-<Roller id="grn" poster={last} values={STEPS.map((step) => step.icon)} /></span>
        <Roller className={s.bigValue} id="grp" poster={last} values={STEPS.map((step) => String(step.px))} />
      </span>
    </div>
  );
}

/** Scenes 4–5: icons in place in a sidebar and a toolbar; then one tone pass follows a cursor down the rows. */
export function PlaceScene({ copy }: { copy: IconCopy }) {
  return <div className={s.placeStage} data-m="place"><Sidebar copy={copy} name="pl" /></div>;
}

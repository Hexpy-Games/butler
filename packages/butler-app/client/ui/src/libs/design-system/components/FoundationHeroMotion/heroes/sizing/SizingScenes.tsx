import type { CSSProperties, ReactNode } from "react";
import { Button } from "../../../Button";
import { IconButton } from "../../../IconButton";
import { MoreHorizontal, Search, Settings } from "../../../Icons";
import { Input } from "../../../Input";
import { SelectButton } from "../../../Select";
import { Annotations } from "../shared/Annotations";
import { openingItems } from "../shared/guides";
import { valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { Annot, Geometry } from "../shared/types";
import { RAILS, type SizingCopy } from "./sizingCopy";
import s from "./SizingHero.module.css";

/** Hit areas of the two small icon controls: the pointer target, then the touch target. */
export const HIT: Annot[] = [
  { kind: "box", target: "i-xs", inflateTo: "p-hit", label: valueLabel("--control-hit-target", true) },
  { kind: "box", target: "i-sm", inflateTo: "p-hit" },
];
export const TOUCH: Annot[] = [
  { kind: "box", target: "i-xs", inflateTo: "p-touch", label: valueLabel("--touch-target", true) },
  { kind: "box", target: "i-sm", inflateTo: "p-touch" },
];

/** The controls that slide onto each rail (`rc-<rail>-<n>`), each at the rail's height. */
function controls(copy: SizingCopy): ReactNode[][] {
  return [
    [<Button key="a" size="xs" text={<R name="rc-t0">{copy.tag}</R>} variant="outline" />,
      <Mark key="b" n="i-xs"><Button aria-label={copy.more} iconStart={<MoreHorizontal size="sm" />} size="icon-xs" variant="outline" /></Mark>],
    [<Mark key="a" n="i-sm"><IconButton label={copy.settings}><Settings size="md" /></IconButton></Mark>,
      <Button key="b" size="sm" text={<R name="rc-t1">{copy.save}</R>} variant="outline" />],
    [<Button key="a" iconStart={<Search size="md" />} text={<R name="rc-t2">{copy.search}</R>} />,
      <SelectButton key="b"><R name="rc-t3">{copy.auto}</R></SelectButton>],
    [<Mark key="a" n="in-lg" sweep><Input readOnly value={copy.query} /></Mark>,
      <Button key="b" size="lg" text={<R name="rc-t4">{copy.find}</R>} />],
  ];
}

/**
 * The token field: four rails at the control heights, drawn across, with
 * real controls that slide on and sit at each rail's height; the small
 * icon controls' hit areas bloom around them (pointer, then touch).
 */
export function SizingField({ g, copy }: { g: Geometry | null; copy: SizingCopy }) {
  const all = controls(copy);
  return (
    <div className={s.field} data-m="field">
      <span className={s.mode}>
        <span className={s.modeLayer} data-t="mode-a"><R name="mode-a-t">{copy.pointer}</R></span>
        <span className={s.modeLayer} data-t="mode-b">{copy.touch}</span>
      </span>
      <div className={s.rails} data-mark-scope="rails">
        {RAILS.map((rail, k) => (
          <div className={s.rail} key={rail.name}>
            <span className={s.railName}><R name={`rl-n${k}`}>{`--control-height-${rail.name}`}</R><span className={s.railValue}><R name={`rl-v${k}`}>{String(rail.px)}</R></span></span>
            <div className={s.band} style={{ "--h": `var(--control-height-${rail.name})` } as CSSProperties}>
              <span className={s.edge} data-edge="t" data-t={`rl-t${k}`} />
              <span className={s.edge} data-edge="b" data-t={`rl-b${k}`} />
              {all[k]!.map((node, n) => <span className={s.slot} data-t={`rc-${k}-${n}`} key={n}>{node}</span>)}
            </div>
          </div>
        ))}
        <Mark n="p-hit"><span className={s.probe} data-kind="hit" /></Mark>
        <Mark n="p-touch"><span className={s.probe} data-kind="touch" /></Mark>
        {g ? <Annotations items={[...openingItems(HIT, g.scopes.rails ?? {}, "h", g.layout), ...openingItems(TOUCH, g.scopes.rails ?? {}, "t", g.layout)]} /> : null}
      </div>
    </div>
  );
}

/** Guides of the app frame: the titlebar, a sidebar row and the sidebar's width. */
export const FRAME: Annot[] = [
  { kind: "size", target: "f-title", axis: "h", label: valueLabel("--titlebar-height", true) },
  { kind: "size", target: "f-r0", axis: "h", label: valueLabel("--sidebar-row-height", true) },
  { kind: "size", target: "f-side", axis: "w", label: valueLabel("--sidebar-width", true) },
];

/** A box of the frame, drawn in through a window (`fb-<n>`). */
function Box({ n, kind }: { n: string; kind: string }) {
  return <Mark block n={n}><span className={s.win} data-t={`fb-${n}`}><span className={s.frameBox} data-kind={kind} data-t={`fb-${n}-in`} /></span></Mark>;
}

/** Scene 4: the app frame as blueprint bands, its chrome measured, left of the poster. */
export function SizingFrame({ g }: { g: Geometry | null }) {
  return (
    <div className={s.frameRegion} data-t="frame">
      <div className={s.frame} data-m="frame" data-mark-scope="frame">
        <Box kind="title" n="f-title" />
        <div className={s.frameBody}>
          <Mark block n="f-side">
            <div className={s.sidebar}>{[0, 1, 2, 3].map((k) => <Box key={k} kind="row" n={`f-r${k}`} />)}</div>
          </Mark>
          <Box kind="content" n="f-content" />
        </div>
        {g ? <Annotations items={openingItems(FRAME, g.scopes.frame ?? {}, "f", g.layout)} shown /> : null}
      </div>
    </div>
  );
}

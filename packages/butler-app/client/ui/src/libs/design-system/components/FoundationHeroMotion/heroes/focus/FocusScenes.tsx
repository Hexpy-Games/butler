import { Button } from "../../../Button";
import { Input } from "../../../Input";
import { Kbd } from "../../../Kbd";
import { SegmentedControl } from "../../../SegmentedControl";
import { Switch } from "../../../Switch";
import type { Box as Rect } from "../../heroTimeline";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { SceneGeometry } from "../scene/types";
import type { FocusCopy } from "./focusCopy";
import { CompactShell, Named, WideShell } from "./FocusShell";
import s from "./FocusHero.module.css";

/**
 * The title's touch: each word is a stop with room for the ring inside the
 * title's box (the descender and the ring's two pixels included), and one
 * ring moves from "Focus" to "ring".
 */
export function TitleWords({ copy }: { copy: FocusCopy }) {
  return (
    <span className={s.titleWords} data-mark-scope="title">
      <Mark n="w0"><span className={s.word}><R name="i-t0">{copy.title}</R></span></Mark>
      <Mark n="w1"><span className={s.word}><R name="i-t1">{copy.title2}</R></span></Mark>
      <span className={s.ring} data-t="tr" />
    </span>
  );
}

export type KeyId = "tab" | "right" | "left" | "back";

const CAPS: Record<KeyId, string[]> = { tab: ["Tab"], right: ["→"], left: ["←"], back: ["⇧", "Tab"] };

/** A key cap stack: the key pressed now shows (cut in place). */
function Keys({ prefix, keys }: { prefix: string; keys: KeyId[] }) {
  return <span className={s.keys}>{keys.map((id) => <span className={s.key} data-t={`${prefix}-${id}`} key={id}><Kbd keys={CAPS[id]} /></span>)}</span>;
}

/** The ring: one overlay, sized and rounded per stop (the control's own corner). */
const Ring = ({ name }: { name: string }) => <span className={s.ring} data-t={name} />;

const SEGMENT = { c3: '[role="radio"][data-state="on"]' };

/** Scene 2: one ring: Tab walks a short row of real controls; the ring takes each one's corner. */
export function RowScene({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.rowStage} data-m="row">
      <div className={s.row} data-mark-scope="row">
        <Mark n="c0"><Button text={copy.continue} /></Mark>
        <Mark n="c1"><Input aria-label={copy.name} readOnly value={copy.name} /></Mark>
        <Mark n="c2"><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></Mark>
        <Named names={SEGMENT}>
          <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week" options={[{ value: "week", label: copy.week }, { value: "month", label: copy.month }]} />
        </Named>
        <Ring name="rr" />
      </div>
      <Keys keys={["tab"]} prefix="rk" />
    </div>
  );
}

/** Scene 3: close on one ring: two pixels, the accent colour, the control's own corner. */
export function CloseUp({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.closeStage}>
      <span className={s.closeTarget} data-m="closeup">
        <span className={s.ringOn}><Button text={copy.continue} /></span>
        <span className={s.note} data-place="top" data-t="cn-w"><R name="cn-w-t">--focus-ring-width 2</R></span>
        <span className={s.note} data-place="bottom" data-t="cn-c"><span className={s.swatch} /><R name="cn-c-t">--focus-ring-color</R></span>
      </span>
    </div>
  );
}

/** The route line from the stop the ring leaves (its right edge) to the text field (its left edge), turning in the gutter beside the composer. */
function jump(from: Rect | undefined, to: Rect | undefined, tall: boolean): string {
  if (!from || !to) return "M0 0";
  const y1 = from.y + from.h / 2;
  const y2 = to.y + Math.min(to.h / 2, 18);
  if (tall) {
    // Out of the toggle's left edge, down the window's inner margin, into the field.
    const x = Math.min(from.x, to.x) - 10;
    return `M${from.x - 4} ${y1}H${x}V${y2}H${to.x}`;
  }
  const x = to.x - 14;
  return `M${from.x + from.w + 4} ${y1}H${x}V${y2}H${to.x}`;
}

/** One layout's route: the shell, the ring over it, its jump line and its region captions. */
function Route({ copy, g, tall }: { copy: FocusCopy; g: SceneGeometry | null; tall: boolean }) {
  const scope = tall ? "route-tall" : "route-wide";
  const marks = g?.scopes[scope] ?? {};
  return (
    <div className={s.routeStage} data-layout-only={tall ? "tall" : "wide"} data-m={tall ? "route-tall" : "route-wide"}>
      <div className={s.routeFrame} data-mark-scope={scope}>
        {tall ? null : (
          <span className={s.captions} data-edge="top">
            <span className={s.caption} data-for="sidebar"><R name="cap-0">{`① ${copy.regions[0]}`}</R></span>
            <span className={s.caption} data-for="list"><R name="cap-1">{`② ${copy.regions[1]}`}</R></span>
          </span>
        )}
        {tall ? <CompactShell copy={copy} live /> : <WideShell copy={copy} live />}
        <svg aria-hidden="true" className={s.route}>
          <path d={jump(tall ? marks.toggle?.box : marks.set?.box, marks.field?.box, tall)} data-t="jump" pathLength={100} />
        </svg>
        <Ring name="sr" />
        <span className={s.captions} data-edge="bottom">
          {tall ? null : <span className={s.caption} data-for="composer"><R name="cap-2">{`③ ${copy.regions[2]}`}</R></span>}
          <Keys keys={["tab", "right", "left", "back"]} prefix="sk" />
        </span>
      </div>
    </div>
  );
}

/** Scene 4 (signature): the route through the real app, in reading order; Shift+Tab walks it back. */
export function RouteScene({ copy, g }: { copy: FocusCopy; g: SceneGeometry | null }) {
  return (
    <div className={s.routes}>
      <Route copy={copy} g={g} tall={false} />
      <Route copy={copy} g={g} tall />
    </div>
  );
}

const RANGE = ["day", "week", "month"] as const;

/** The range picker (a roving radio group) with one value selected: the hero cuts between them as arrows move the selection. */
export function Range({ copy, value, named = false }: { copy: FocusCopy; value: string; named?: boolean }) {
  const labels = { day: copy.day, week: copy.week, month: copy.month };
  const control = <SegmentedControl ariaLabel={copy.range} onValueChange={() => undefined} value={value} options={RANGE.map((id) => ({ value: id, label: labels[id] }))} />;
  if (!named) return control;
  return <Named names={Object.fromEntries(RANGE.map((id, k) => [`g${k}`, `[role="radio"]:nth-of-type(${k + 1})`]))}>{control}</Named>;
}

/** Scene 5: a group is one Tab stop; arrows move inside it (the selection follows); Tab leaves to the next control. */
export function GroupScene({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.groupStage} data-m="group">
      <div className={s.groupFrame} data-mark-scope="group">
        <span className={s.stacked}>
          {RANGE.map((id, k) => <span data-t={`gv-${k}`} key={id}><Range copy={copy} named={k === 0} value={id} /></span>)}
        </span>
        <Mark n="apply"><Button text={copy.apply} /></Mark>
        <Ring name="gr" />
      </div>
      <span className={s.caption}><R name="rv">{copy.roving}</R></span>
      <Keys keys={["tab", "right"]} prefix="gk" />
    </div>
  );
}

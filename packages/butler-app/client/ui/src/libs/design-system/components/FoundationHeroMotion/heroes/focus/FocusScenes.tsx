import { NavRow } from "../../../../blocks/NavRow";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { Folder, MessageSquare, Search } from "../../../Icons";
import { Input } from "../../../Input";
import { Kbd } from "../../../Kbd";
import { SegmentedControl } from "../../../SegmentedControl";
import { Switch } from "../../../Switch";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import type { Box as Rect } from "../../heroTimeline";
import { Mark } from "../shared/Mark";
import type { SceneGeometry } from "../scene/types";
import type { FocusCopy } from "./focusCopy";
import { Composer, Turn } from "./focusTiles";
import s from "./FocusHero.module.css";

/** The title's touch: a 2px ring around "Focus", then around "ring". */
export function TitleWords({ copy }: { copy: FocusCopy }) {
  return (
    <span className={s.titleWords}>
      <span className={s.word}>{copy.title}<span className={s.wordRing} data-t="tr-0" /></span>
      <span className={s.word}>{copy.title2}<span className={s.wordRing} data-t="tr-1" /></span>
    </span>
  );
}

/** A key cap stack: the key pressed now shows (cut in place). */
function Keys({ prefix, keys }: { prefix: string; keys: Array<[id: string, caps: string[]]> }) {
  return <span className={s.keys}>{keys.map(([id, caps]) => <span className={s.key} data-t={`${prefix}-${id}`} key={id}><Kbd keys={caps} /></span>)}</span>;
}

/** Scene 2: one ring: Tab walks a short row of real controls; the ring takes each one's corner. */
export function RowScene({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.rowStage} data-m="row">
      <div className={s.row} data-mark-scope="row">
        <Mark n="c0"><Button text={copy.continue} /></Mark>
        <Mark n="c1"><Input aria-label={copy.name} readOnly value={copy.name} /></Mark>
        <Mark n="c2"><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></Mark>
        <Mark n="c3">
          <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week" options={[{ value: "week", label: copy.week }, { value: "month", label: copy.month }]} />
        </Mark>
        <span className={s.ring} data-t="rr" />
      </div>
      <Keys keys={[["tab", ["Tab"]]]} prefix="rk" />
    </div>
  );
}

/** Scene 3: close on one ring: two pixels, the accent colour, the control's own corner. */
export function CloseUp({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.closeStage}>
      <span className={s.closeTarget} data-m="closeup">
        <Button text={copy.continue} />
        <span className={s.staticRing} />
        <span className={s.note} data-place="top" data-t="cn-w">--focus-ring-width 2</span>
        <span className={s.note} data-place="bottom" data-t="cn-c"><span className={s.swatch} />--focus-ring-color</span>
      </span>
    </div>
  );
}

/** The route's line between two marks of the shell: from one stop's right edge to the next stop's left edge. */
function segment(from: Rect | undefined, to: Rect | undefined): string {
  if (!from || !to) return "M0 0";
  const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  return `M${a.x} ${a.y}L${b.x} ${a.y}L${b.x} ${b.y}`;
}

/** Scene 4 (signature): the route through a real app shell; Tabs is one stop, crossfaded over it; Shift+Tab walks back. */
export function RouteScene({ copy, g }: { copy: FocusCopy; g: SceneGeometry | null }) {
  const marks = g?.scopes.route ?? {};
  return (
    <div className={s.routeStage} data-m="route" data-mark-scope="route">
      <div className={s.shell} data-t="shell">
        <div className={s.main}>
          <span className={s.region} data-n="1">{`① ${copy.regions[0]}`}</span>
          <Box border="hairline" padding="sm" radius="panel" surface="raised">
            <div className={s.sidebar}>
              {[[copy.chats, <MessageSquare key="i" size="sm" />], [copy.projects, <Folder key="i" size="sm" />], [copy.files, <Search key="i" size="sm" />]].map(([label, icon], k) => (
                <Mark block key={k} n={`r${k}`}><NavRow active={k === 0} icon={icon} label={label} /></Mark>
              ))}
            </div>
          </Box>
        </div>
        <div className={s.main}>
          <span className={s.region} data-n="2">{`② ${copy.regions[1]}`}</span>
          <Turn copy={copy} />
          <span className={s.region} data-n="3">{`③ ${copy.regions[2]}`}</span>
          <Composer copy={copy} live />
        </div>
      </div>
      <svg className={s.route} aria-hidden="true" data-t="route-lines">
        <path d={segment(marks.r2?.box, marks.field?.box)} data-t="seg-1" pathLength={100} />
        <path d={segment(marks.field?.box, marks.send?.box)} data-t="seg-2" pathLength={100} />
      </svg>
      <div className={s.tabsLayer} data-t="tabs">
        <Tabs defaultValue="summary">
          <TabsList aria-label={copy.summary}>
            {[copy.summary, copy.filesTab, copy.activity].map((label, k) => <Mark key={label} n={`t${k}`}><TabsTrigger value={k === 0 ? "summary" : `t${k}`}>{label}</TabsTrigger></Mark>)}
          </TabsList>
        </Tabs>
        <Mark n="tp"><Button text={copy.open} variant="outline" /></Mark>
        <span className={s.roving} data-t="rv-t">{copy.roving}</span>
      </div>
      <span className={s.indicator} data-t="ti" />
      <span className={s.ring} data-t="sr" />
      <Keys keys={[["tab", ["Tab"]], ["down", ["↓"]], ["right", ["→"]], ["back", ["⇧", "Tab"]]]} prefix="sk" />
    </div>
  );
}

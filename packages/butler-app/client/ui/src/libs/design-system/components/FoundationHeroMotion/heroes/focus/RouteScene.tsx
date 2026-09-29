import type { Box as Rect } from "../../heroTimeline";
import { Reveal as R } from "../shared/Reveal";
import type { SceneGeometry } from "../scene/types";
import type { FocusCopy } from "./focusCopy";
import { CompactShell } from "./CompactShell";
import { WideShell } from "./WideShell";
import { Ring } from "./FocusScenes";
import { Keys } from "./Keys";
import s from "./FocusHero.module.css";

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

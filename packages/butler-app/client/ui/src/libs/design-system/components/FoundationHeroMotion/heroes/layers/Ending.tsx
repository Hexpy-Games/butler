import type { SceneGeometry } from "../scene/types";
import { type LayersCopy } from "./layersCopy";
import { Ladder } from "./Ladder";
import { Screen } from "./Screen";
import s from "./LayersHero.module.css";

/** The window and, beside it, the ladder the window slides to make room for: one element, so the window on the finale is the very one that was taken apart. */
export function Ending({ copy, g }: { copy: LayersCopy; g: SceneGeometry | null }) {
  return (
    <div className={s.ending}>
      <Screen copy={copy} g={g} live />
      <div className={s.ladderBox} data-m="ladder">
        <Ladder copy={copy} live />
      </div>
    </div>
  );
}

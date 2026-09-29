import { type LayersCopy } from "./layersCopy";
import { Screen } from "./Screen";
import s from "./LayersHero.module.css";

/** The poster's window, drawn smaller to fit its tile. */
export function PosterScreen({ copy }: { copy: LayersCopy }) {
  return (
    <div className={s.posterScreen}>
      <Screen copy={copy} live={false} />
    </div>
  );
}

import { KeyValueRow } from "../../../../blocks/KeyValueRow";
import { Typo } from "../../../Typo";
import { LAYERS, zToken, zValue, type LayersCopy } from "./layersCopy";
import s from "./LayersHero.module.css";

/** Finale: every z token, high to low, with its value and what lives there (live in the scene: each row is written in turn). */
export function Ladder({ copy, live = false }: { copy: LayersCopy; live?: boolean }) {
  return (
    <div className={s.ladder}>
      {[...LAYERS].reverse().map((layer, i) => (
        <div data-t={live ? `lr-${i}` : undefined} key={layer}>
          <KeyValueRow description={copy.lives[layer]} label={<Typo.Code>{zToken(layer)}</Typo.Code>} value={zValue(layer)} />
        </div>
      ))}
    </div>
  );
}

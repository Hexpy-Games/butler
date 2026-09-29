import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { LAYERS_COPY, type LayersCopy } from "./layersCopy";
import { Ending, Ladder, PosterScreen, TitleCopies } from "./LayersScenes";
import { LAYERS_END, layersTracks } from "./layersTracks";
import s from "./LayersHero.module.css";

function spec(copy: LayersCopy): SceneSpec {
  return {
    code: "layers",
    scenes: ["intro", "screen"],
    regions: {
      intro: <Intro lead={copy.lead} title={copy.title} titleNode={<TitleCopies title={copy.title} />} />,
      screen: (g) => (
        <div className={s.region} data-t="warm">
          <Ending copy={copy} g={g} />
        </div>
      ),
    },
    tiles: {
      screen: <PosterScreen copy={copy} />,
      ladder: <Ladder copy={copy} />,
    },
    poster: {
      wide: { columns: "3.6fr 1fr", rows: "1fr", areas: ["screen ladder"] },
      tall: { columns: "1fr", rows: "auto", areas: ["screen", "ladder"] },
    },
    posterZoom: { wide: 0.8, tall: 0.9 },
    deep: ["screen"],
    stay: true,
    tallByTiles: true,
    end: () => LAYERS_END,
    tracks: layersTracks(copy),
  };
}

/**
 * 09 Layers, "the exploded stack": the Butler window, flat; the camera turns
 * to a quarter view and the window separates into its layers one at a time,
 * each named by its z token on its own corner; then the sheets settle and
 * the window is flat again.
 */
export function LayersHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(LAYERS_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

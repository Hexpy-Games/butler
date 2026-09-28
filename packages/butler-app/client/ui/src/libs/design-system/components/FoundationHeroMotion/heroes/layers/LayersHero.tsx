import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { LAYERS_COPY, type LayersCopy } from "./layersCopy";
import { Ladder, Screen, TitleCopies } from "./LayersScenes";
import { LAYERS_END, layersTracks } from "./layersTracks";
import s from "./LayersHero.module.css";

function spec(copy: LayersCopy): SceneSpec {
  return {
    code: "layers",
    scenes: ["intro", "screen"],
    regions: {
      intro: <Intro lead={copy.lead} title={copy.title} titleNode={<TitleCopies title={copy.title} />} />,
      screen: <div className={s.region}><Screen copy={copy} live /></div>,
    },
    tiles: {
      stack: <div className={s.exploded}><Screen copy={copy} exploded live={false} /></div>,
      flat: <Screen copy={copy} live={false} />,
      ladder: <Ladder />,
    },
    poster: {
      wide: { columns: "1.25fr 1fr", rows: "1.2fr 1fr", areas: ["stack flat", "stack ladder"] },
      tall: { columns: "1fr", rows: "auto", areas: ["stack", "ladder"] },
    },
    posterZoom: { wide: 0.8, tall: 0.95 },
    deep: ["screen"],
    end: () => LAYERS_END,
    tracks: layersTracks(copy),
  };
}

/**
 * 09 Layers, "the exploded stack": a real screen, flat; the camera tilts and
 * its layers separate along z one at a time, each named by its token; the
 * portal rule and the drag ride; then the stack closes back to the flat
 * screen it was all along.
 */
export function LayersHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(LAYERS_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

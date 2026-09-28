import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { layersBuilds } from "./layersBuilds";
import { LAYERS_COPY, type LayersCopy } from "./layersCopy";
import { layersPrelude } from "./layersPrelude";
import { LayersField, LayersScreen } from "./LayersScenes";
import s from "./LayersHero.module.css";

function spec(copy: LayersCopy): ChapterSpec {
  return {
    code: "layers",
    prelude: {
      ...layersPrelude(copy),
      cells: ["intro", "field", "screen"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, screen: <LayersScreen copy={copy} /> },
    },
    field: <LayersField />,
    fieldScene: <LayersField />,
    fieldColumns: 4,
    posterZoom: 1.2,
    product: s.product!,
    builds: layersBuilds(copy),
  };
}

/**
 * 09 Layers, "stacking order, flat": the intent; the z tokens drop in as
 * numbered sheets; a screen builds layer by layer, then a slider spreads the
 * layers apart along a flat diagonal and closes them; components by topic
 * with z badges; the sheets beside them.
 */
export function LayersHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(LAYERS_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { radiusBuilds } from "./radiusBuilds";
import { RADIUS_COPY, type RadiusCopy } from "./radiusCopy";
import { radiusPrelude } from "./radiusPrelude";
import { RadiusField, RadiusLab } from "./RadiusScenes";
import s from "./RadiusHero.module.css";

function spec(copy: RadiusCopy): ChapterSpec {
  return {
    code: "radius",
    prelude: {
      ...radiusPrelude(copy),
      cells: ["intro", "lab", "field"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, lab: (g) => <RadiusLab g={g} /> },
    },
    field: (g) => <RadiusField copy={copy} g={g} />,
    fieldScene: (g) => <RadiusField copy={copy} g={g} />,
    fieldColumns: 5,
    posterZoom: 1.2,
    product: s.product!,
    builds: radiusBuilds(copy),
  };
}

/**
 * 05 Radius and elevation, "corners grow with the surface": the intent; a
 * square morphs its corners through the ladder; nested surfaces show corners
 * growing outward; the elevations lift with their shadow guides; components
 * by topic with radius circles and shadow badges; the ladder beside them.
 */
export function RadiusHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(RADIUS_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { RADIUS_COPY, type RadiusCopy } from "./radiusCopy";
import { CornerScene, FloorScene, NestScene, WearScene } from "./RadiusScenes";
import { Composer, CornerTile, LiftTile, RowTile } from "./radiusTiles";
import { RADIUS_END, RADIUS_SPANS, radiusTracks } from "./radiusTracks";
import s from "./RadiusHero.module.css";

/** The title's touch: a control-radius outline drawing behind the R's bowl, one stroke. */
const Bowl = (
  <svg className={s.bowl}>
    <rect data-t="dec" height="100%" pathLength={100} rx="16" width="100%" />
  </svg>
);

function spec(copy: RadiusCopy): SceneSpec {
  return {
    code: "radius",
    scenes: ["intro", "corner", "wear", "nest", "floor"],
    regions: {
      intro: <Intro decor={Bowl} lead={copy.lead} title={copy.title} />,
      corner: (g) => <CornerScene copy={copy} layout={g?.layout ?? "wide"} />,
      wear: <WearScene copy={copy} />,
      nest: <NestScene copy={copy} />,
      floor: <FloorScene copy={copy} />,
    },
    tiles: {
      corner: <CornerTile />,
      row: <RowTile copy={copy} />,
      composer: <Composer copy={copy} />,
      lift: <LiftTile copy={copy} />,
    },
    poster: {
      wide: { columns: "0.8fr 1fr 1fr", rows: "1fr 1fr", areas: ["corner row row", "corner composer lift"] },
      tall: { columns: "1fr", rows: "auto", areas: ["corner", "row", "composer", "lift"] },
    },
    // The row stays hidden while the pill's zoom-out would show it.
    spans: { wear: [RADIUS_SPANS.wear] },
    end: () => RADIUS_END,
    tracks: radiusTracks(copy),
  };
}

/**
 * 05 Radius and elevation, "one corner, then the floor": a single corner
 * under a loupe morphs through the radius ladder, a hold on each; a ghost arc
 * finds who wears which corner; one nested pair shows the rule; three
 * surfaces rise off a floor in quarter view; the poster packs it all.
 */
export function RadiusHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(RADIUS_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

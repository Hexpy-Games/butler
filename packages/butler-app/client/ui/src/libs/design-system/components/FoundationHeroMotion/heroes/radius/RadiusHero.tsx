import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { RADIUS_COPY, type RadiusCopy } from "./radiusCopy";
import { CornerScene } from "./CornerScene";
import { DragScene } from "./DragScene";
import { NestScene } from "./NestScene";
import { OverScene } from "./OverScene";
import { PressScene } from "./PressScene";
import { WearScene } from "./WearScene";
import { Composer } from "./Composer";
import { CornerTile } from "./CornerTile";
import { LiftTile } from "./LiftTile";
import { RowTile } from "./RowTile";
import { RADIUS_END, RADIUS_SPANS, radiusTracks } from "./radiusTracks";

function spec(copy: RadiusCopy): SceneSpec {
  return {
    code: "radius",
    scenes: ["intro", "corner", "wear", "nest", "press", "drag", "over"],
    regions: {
      // The R's own corners are square, so the title carries no arc: the corner scene draws the first one, exactly.
      intro: <Intro lead={copy.lead} title={copy.title} />,
      corner: (g) => <CornerScene copy={copy} layout={g?.layout ?? "wide"} />,
      wear: <WearScene copy={copy} />,
      nest: <NestScene copy={copy} />,
      press: <PressScene copy={copy} />,
      drag: <DragScene copy={copy} />,
      over: <OverScene copy={copy} />,
    },
    tiles: {
      corner: <CornerTile />,
      row: <RowTile copy={copy} />,
      composer: <Composer copy={copy} />,
      lift: <LiftTile copy={copy} />,
    },
    poster: {
      wide: { columns: "0.7fr 1fr", rows: "0.8fr 0.9fr 0.9fr", areas: ["corner row", "corner composer", "corner lift"] },
      tall: { columns: "1fr", rows: "auto", areas: ["corner", "row", "composer", "lift"] },
    },
    // The pill fades as the camera sets off; the row shows once it has gone (the pill's zoom-out would overlap it).
    spans: { corner: [0, RADIUS_SPANS.wear - 1], wear: [RADIUS_SPANS.wear + 0.4] },
    end: () => RADIUS_END,
    tracks: radiusTracks(copy),
  };
}

/**
 * 05 Radius and elevation, "one corner, then the shadows in use": a single
 * corner under a loupe morphs through the radius ladder, a hold on each; an
 * arc draws itself on each real component's corner; one nested pair shows
 * the rule; then one shadow at a time as real UI rises (a pressed control, a
 * dragged card, a window over content); the poster packs it all.
 */
export function RadiusHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(RADIUS_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

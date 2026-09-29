import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { SPACING_COPY, type SpacingCopy } from "./spacingCopy";
import { CountScene, DensityScene, RhythmScene, StairScene, TitleLetters } from "./SpacingScenes";
import { CardTile, InlineTile, SectionTile, StairsTile } from "./spacingTiles";
import { SPACING_END, spacingTracks } from "./spacingTracks";

function spec(copy: SpacingCopy): SceneSpec {
  return {
    code: "spacing",
    scenes: ["intro", "stairs", "ex", "rh", "dn"],
    regions: {
      intro: <Intro lead={copy.lead} title={copy.title} titleNode={<TitleLetters title={copy.title} />} />,
      stairs: <StairScene copy={copy} />,
      ex: <CountScene copy={copy} />,
      rh: <RhythmScene copy={copy} />,
      dn: <DensityScene copy={copy} />,
    },
    tiles: {
      stairs: <StairsTile />,
      section: <SectionTile copy={copy} />,
      inline: <InlineTile copy={copy} />,
      card: <CardTile copy={copy} />,
    },
    poster: {
      wide: { columns: "1fr 1.3fr", rows: "1.3fr 0.7fr 0.8fr", areas: ["stairs section", "stairs inline", "stairs card"] },
      tall: { columns: "1fr", rows: "auto", areas: ["stairs", "section", "inline", "card"] },
    },
    posterZoom: { wide: 0.9, tall: 0.9 },
    end: () => SPACING_END,
    tracks: spacingTracks(copy),
  };
}

/**
 * 03 Spacing, "counted space": the title's letters drift apart on 4px
 * blocks; one 4px unit, named, shrinks into the xs slot and the named scale
 * builds from it; each space of a real settings section is highlighted and
 * counted in a column of units beside it; the page's rhythm in units;
 * comfortable beside compact.
 */
export function SpacingHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(SPACING_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { ICON_COPY, type IconCopy } from "./iconCopy";
import { GlyphScene, GrowScene, PlaceScene, TitleWord } from "./IconScenes";
import { EmptyTile, KeyTile, LadderTile, SideTile } from "./iconTiles";
import { ICON_END, iconTracks } from "./iconTracks";

function spec(copy: IconCopy): SceneSpec {
  return {
    code: "icon",
    scenes: ["intro", "glyph", "grow", "place"],
    regions: {
      intro: <Intro lead={copy.lead} title={copy.title} titleNode={<TitleWord title={copy.title} />} />,
      glyph: <GlyphScene copy={copy} />,
      grow: <GrowScene copy={copy} />,
      place: <PlaceScene copy={copy} />,
    },
    tiles: {
      key: <KeyTile copy={copy} />,
      ladder: <LadderTile copy={copy} />,
      side: <SideTile copy={copy} />,
      empty: <EmptyTile copy={copy} />,
    },
    poster: {
      wide: { columns: "1fr 1fr 0.9fr", rows: "2fr 1fr", areas: ["key ladder side", "key ladder empty"] },
      tall: { columns: "1fr", rows: "auto", areas: ["key", "ladder", "side"] },
    },
    posterZoom: { wide: 0.9, tall: 0.9 },
    end: () => ICON_END,
    tracks: iconTracks(copy),
  };
}

/**
 * 06 Iconography, "the icon follows the text": the title's o strokes on as
 * a glyph; the gear on its 24px keyline grid; one label steps caption to h2
 * and its icon swaps named size in lockstep on one centre line; icons in
 * place in a sidebar and a toolbar, and one tone pass down the rows.
 */
export function IconHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(ICON_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

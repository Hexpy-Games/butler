import { useCallback } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { HeroLayout } from "../shared/grid";
import { Intro } from "../shared/Intro";
import { ICON_COPY } from "./iconCopy";
import { GlyphScene } from "./GlyphScene";
import { GridScene } from "./GridScene";
import { GrowScene } from "./GrowScene";
import { PlaceScene } from "./PlaceScene";
import { TitleWord } from "./TitleWord";
import { IconStage } from "./IconStage";

/**
 * 06 Iconography, "the icon follows the text": the title's o strokes on as
 * a glyph; the gear on its 24px keyline grid; one label steps caption to h2
 * and its icon swaps named size in lockstep on one centre line; the app's
 * sidebar, its icons popping in and a click on Settings; then the camera
 * lands close on that gear at the centre of the whole icon set, which draws
 * one diagonal at a time while the camera pulls out to the full frame.
 */
export function IconHero({ lang }: { lang: FoundationHeroLang }) {
  const copy = ICON_COPY[lang];
  const regions = useCallback((layout: HeroLayout) => ({
    intro: <Intro lead={copy.lead} title={copy.title} titleNode={<TitleWord title={copy.title} />} />,
    glyph: <GlyphScene copy={copy} />,
    grow: <GrowScene copy={copy} />,
    place: <PlaceScene copy={copy} />,
    grid: <GridScene layout={layout} />,
  }), [copy]);
  return <IconStage copy={copy} lang={lang} regions={regions} />;
}

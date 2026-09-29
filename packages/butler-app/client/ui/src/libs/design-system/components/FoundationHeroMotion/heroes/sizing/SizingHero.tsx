import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { SIZING_COPY, type SizingCopy } from "./sizingCopy";
import { ChromeScene, StaffScene, TitleRails, TouchScene } from "./SizingScenes";
import { FormTile, FrameTile, HaloTile, StaffTile } from "./sizingTiles";
import { SIZING_END, sizingTracks } from "./sizingTracks";

function spec(copy: SizingCopy): SceneSpec {
  return {
    code: "sizing",
    scenes: ["intro", "staff", "touch", "chrome"],
    regions: {
      intro: <Intro decor={TitleRails} lead={copy.lead} title={copy.title} />,
      staff: <StaffScene copy={copy} />,
      touch: <TouchScene copy={copy} />,
      chrome: <ChromeScene copy={copy} />,
    },
    tiles: {
      staff: <StaffTile copy={copy} />,
      frame: <FrameTile copy={copy} />,
      halo: <HaloTile copy={copy} />,
      form: <FormTile copy={copy} />,
    },
    poster: {
      wide: { columns: "1.15fr 1fr", rows: "1.4fr 1fr 1fr", areas: ["staff staff", "frame halo", "frame form"] },
      tall: { columns: "1fr", rows: "auto", areas: ["staff", "halo", "frame"] },
    },
    posterZoom: { wide: 0.95, tall: 0.9 },
    end: () => SIZING_END,
    tracks: sizingTracks(copy),
  };
}

/**
 * 04 Sizing, "rails and targets": four rails under the title; real controls
 * drop into lanes one control height tall and an off-rail size snaps onto
 * one; the pointer's 30px target becomes touch's 44 on every button at once;
 * the frame's fixed measures on its edge.
 */
export function SizingHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(SIZING_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

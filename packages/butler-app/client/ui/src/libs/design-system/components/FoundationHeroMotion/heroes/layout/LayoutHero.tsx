import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { LAYOUT_COPY, type LayoutCopy } from "./layoutCopy";
import { ShellScene, TitleFrame } from "./LayoutScenes";
import { ExpandedTile, MediumTile, ModesTile, PhoneTile } from "./layoutTiles";
import { LAYOUT_END, layoutTracks } from "./layoutTracks";

function spec(copy: LayoutCopy): SceneSpec {
  return {
    code: "layout",
    scenes: ["intro", "shell"],
    regions: {
      intro: <Intro decor={TitleFrame} lead={copy.lead} title={copy.title} />,
      shell: <ShellScene copy={copy} />,
    },
    tiles: {
      exp: <ExpandedTile copy={copy} />,
      med: <MediumTile copy={copy} />,
      phone: <PhoneTile copy={copy} />,
      modes: <ModesTile />,
    },
    poster: {
      wide: { columns: "1.7fr 0.55fr 0.75fr", rows: "1fr 1fr", areas: ["exp med med", "exp phone modes"] },
      tall: { columns: "1fr 1fr", rows: "auto", areas: ["exp med", "phone phone"] },
    },
    posterZoom: { wide: 0.9, tall: 0.9 },
    end: () => LAYOUT_END,
    tracks: layoutTracks(copy),
  };
}

/**
 * 10 Layout and platform, "one shell, three modes": an empty page frame
 * measured on its rim; the real shell fills it; a handle drags it from 1280
 * to 375, the shell relaying out at each detent; at 375 the sidebar is a
 * drawer and the device supplies its insets.
 */
export function LayoutHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(LAYOUT_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { LAYOUT_COPY, type LayoutCopy } from "./layoutCopy";
import { Hud } from "./LayoutScenes";
import { Ruler } from "./Ruler";
import { ScreenTile } from "./ScreenTile";
import { WindowScene } from "./WindowScene";
import { LAYOUT_END, layoutTracks } from "./layoutTracks";

function spec(copy: LayoutCopy): SceneSpec {
  return {
    code: "layout",
    scenes: ["intro", "stage"],
    regions: {
      intro: <Intro lead={copy.lead} title={copy.title} />,
      stage: <WindowScene copy={copy} />,
    },
    tiles: {
      expanded: <ScreenTile copy={copy} mode="expanded" />,
      compact: <ScreenTile copy={copy} mode="compact" open={false} />,
      ruler: <Ruler />,
    },
    poster: {
      wide: { columns: "1fr 2.75fr", rows: "1fr auto", areas: ["compact expanded", "ruler ruler"] },
      tall: { columns: "1fr", rows: "460px auto", areas: ["compact", "ruler"] },
    },
    hud: <Hud />,
    posterZoom: { wide: 1, tall: 1 },
    end: () => LAYOUT_END,
    tracks: layoutTracks(copy),
  };
}

/**
 * 10 Layout and platform, "one shell, three modes": Butler's real app shell
 * in a window, its titlebar, sidebar and conversation column measured on the
 * window's rim; a handle drags the window from 1280 to 375 while the shell
 * reflows, each breakpoint of responsive.ts handing it to the next mode; at
 * 375 the sidebar opens as a full-width drawer.
 */
export function LayoutHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(LAYOUT_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

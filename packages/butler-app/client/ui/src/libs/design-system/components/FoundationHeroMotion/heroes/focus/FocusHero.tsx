import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { FOCUS_COPY, type FocusCopy } from "./focusCopy";
import { CloseUp, RouteScene, RowScene, TabsScene, TitleWords } from "./FocusScenes";
import { CloseTile, RowTile, ShellTile, TabsTile } from "./focusTiles";
import { focusEnd, focusTracks } from "./focusTracks";

function spec(copy: FocusCopy): SceneSpec {
  return {
    code: "focus",
    scenes: ["intro", "row", "closeup", "route", "tabs"],
    regions: {
      intro: <Intro lead={copy.lead} title={`${copy.title} ${copy.title2}`} titleNode={<TitleWords copy={copy} />} />,
      row: <RowScene copy={copy} />,
      closeup: <CloseUp copy={copy} />,
      route: (g) => <RouteScene copy={copy} g={g} />,
      tabs: <TabsScene copy={copy} />,
    },
    tiles: {
      shell: <ShellTile copy={copy} />,
      tabs: <TabsTile copy={copy} />,
      row: <RowTile copy={copy} />,
      close: <CloseTile copy={copy} />,
    },
    poster: {
      wide: { columns: "1.45fr 1fr", rows: "1fr 1fr 1fr", areas: ["shell tabs", "shell row", "shell close"] },
      tall: { columns: "1fr", rows: "auto", areas: ["shell", "tabs", "row", "close"] },
    },
    posterZoom: { wide: 0.8, tall: 0.9 },
    end: focusEnd,
    tracks: focusTracks(copy),
  };
}

/**
 * 07 Focus ring, "the route": one ring takes each control's corner; a close-up
 * of its two pixels; then the ring travels the real app in reading order, Tab
 * between stops and arrow keys inside a group, and Shift+Tab walks the route
 * back; a tab list is one stop. Every ring is the DS focus-visible style.
 */
export function FocusHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(FOCUS_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

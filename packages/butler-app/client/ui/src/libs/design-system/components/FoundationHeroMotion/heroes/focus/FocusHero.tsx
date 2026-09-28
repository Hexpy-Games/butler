import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { FOCUS_COPY, type FocusCopy } from "./focusCopy";
import { CloseUp, RouteScene, RowScene, TitleWords } from "./FocusScenes";
import { CloseTile, RowTile, ShellTile, TabsTile } from "./focusTiles";
import { FOCUS_END, focusTracks } from "./focusTracks";

function spec(copy: FocusCopy): SceneSpec {
  return {
    code: "focus",
    scenes: ["intro", "row", "closeup", "route"],
    regions: {
      intro: <Intro lead={copy.lead} title={`${copy.title} ${copy.title2}`} titleNode={<TitleWords copy={copy} />} />,
      row: <RowScene copy={copy} />,
      closeup: <CloseUp copy={copy} />,
      route: (g) => <RouteScene copy={copy} g={g} />,
    },
    tiles: {
      shell: <ShellTile copy={copy} />,
      tabs: <TabsTile copy={copy} />,
      row: <RowTile copy={copy} />,
      close: <CloseTile copy={copy} />,
    },
    poster: {
      wide: { columns: "1fr 1fr 1fr", rows: "1.35fr 1fr", areas: ["shell shell shell", "tabs row close"] },
      tall: { columns: "1fr", rows: "auto", areas: ["shell", "tabs", "row", "close"] },
    },
    posterZoom: { wide: 0.8, tall: 0.9 },
    end: () => FOCUS_END,
    tracks: focusTracks(copy),
  };
}

/**
 * 07 Focus ring, "the route": one ring takes each control's corner; a close-up
 * of its two pixels; then the ring travels a real app shell in reading order,
 * Tab between regions and arrow keys inside one, Tabs as a single stop, and
 * Shift+Tab walks the route back.
 */
export function FocusHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(FOCUS_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

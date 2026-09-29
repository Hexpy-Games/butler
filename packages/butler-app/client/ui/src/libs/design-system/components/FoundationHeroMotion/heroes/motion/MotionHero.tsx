import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { MOTION_COPY, type MotionCopy } from "./motionCopy";
import { Lanes } from "./Lanes";
import { Metronome } from "./Metronome";
import { Score } from "./Score";
import { Twins } from "./Twins";
import { Exits } from "./Exits";
import { Spring } from "./Spring";
import { Tail } from "./Tail";
import { AT } from "./motionScore";
import { MOTION_END, motionTracks } from "./motionTracks";
import s from "./MotionHero.module.css";

/** The title on the beat: one letter per tick. */
function Letters({ title }: { title: string }) {
  return <span className={s.letters}>{[...title].map((letter, k) => <span className={s.letter} data-t={`ml-${k}`} key={k}>{letter}</span>)}</span>;
}

function spec(copy: MotionCopy): SceneSpec {
  return {
    code: "motion",
    scenes: ["intro", "lanes", "exits", "score", "twins", "spring"],
    regions: {
      intro: <Intro lead={copy.lead} title={copy.title} titleNode={<Letters title={copy.title} />} />,
      lanes: <Lanes copy={copy} live />,
      exits: <Exits copy={copy} />,
      score: <Score copy={copy} live />,
      twins: <Twins copy={copy} live />,
      spring: <Spring copy={copy} live />,
    },
    tiles: {
      lanes: <Lanes copy={copy} live={false} />,
      score: <Score copy={copy} live={false} />,
      twins: <Twins copy={copy} live={false} />,
      tail: <Tail copy={copy} />,
    },
    poster: {
      wide: { columns: "1fr 1fr", rows: "auto auto", areas: ["lanes score", "twins tail"] },
      tall: { columns: "1fr", rows: "auto", areas: ["score", "tail"] },
    },
    posterZoom: { wide: 0.55, tall: 1 },
    // Each scene shows only around its own stretch, so no neighbour peeks into a zoomed-out frame.
    spans: { intro: [0, AT.lanes], lanes: [AT.lanes, AT.exits], exits: [AT.exits, AT.score], score: [AT.score, AT.twins], twins: [AT.twins, AT.spring], spring: [AT.spring + 2] },
    hud: <Metronome />,
    // The metronome stands on the bottom margin; the poster keeps clear of it.
    finaleReserve: { wide: 32, tall: 20 },
    end: () => MOTION_END,
    tracks: motionTracks(copy),
  };
}

/**
 * 08 Motion, "the score": the title lands on the beat; onion-skin lanes show
 * where each curve spends its time; the composer's menu enters, then exits
 * faster; a real Butler turn plays over its piano roll; Full and Reduced play
 * in turn; the spring is kept for the Switch. A metronome ticks throughout
 * and every move starts on a tick (see motionScore.ts).
 */
export function MotionHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(MOTION_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

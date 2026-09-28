import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { SceneHero } from "../scene/SceneHero";
import type { SceneSpec } from "../scene/types";
import { Intro } from "../shared/Intro";
import { MOTION_COPY, type MotionCopy } from "./motionCopy";
import { Lanes, Metronome } from "./motionLanes";
import { Exits, Score, Spring, Twins } from "./MotionScenes";
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
      spring: <Spring copy={copy} live={false} />,
    },
    poster: {
      wide: { columns: "0.9fr 0.62fr 0.48fr", rows: "1.25fr 1fr", areas: ["lanes score score", "lanes twins spring"] },
      tall: { columns: "1fr", rows: "auto", areas: ["lanes", "score", "twins", "spring"] },
    },
    posterZoom: { wide: 0.55, tall: 0.9 },
    hud: <Metronome />,
    end: () => MOTION_END,
    tracks: motionTracks(copy),
  };
}

/**
 * 08 Motion, "the score": the title enters on the beat; onion-skin lanes show
 * where each curve spends its time; exits run faster than entrances; a real
 * conversation turn plays over its piano roll; Full and Reduced play in turn;
 * the spring is kept for the Switch. A metronome ticks all the way through.
 */
export function MotionHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(MOTION_COPY[lang]), [lang]);
  return <SceneHero lang={lang} spec={chapter} />;
}

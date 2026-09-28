import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { motionBuilds } from "./motionBuilds";
import { MOTION_COPY, type MotionCopy } from "./motionCopy";
import { motionPrelude, motionReplays } from "./motionPrelude";
import { MotionField, ReduceDemo } from "./MotionScenes";
import s from "./MotionHero.module.css";

function spec(copy: MotionCopy): ChapterSpec {
  return {
    code: "motion",
    prelude: {
      ...motionPrelude(copy),
      cells: ["intro", "field", "reduce"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, reduce: <ReduceDemo copy={copy} /> },
    },
    field: <MotionField />,
    fieldColumns: 5,
    posterZoom: 1.2,
    product: s.product!,
    builds: motionBuilds(copy),
    extra: motionReplays,
  };
}

/**
 * 08 Motion, "easing curves drive real transitions": the intent; the five
 * easing curves plotted from their live values, a dot running each; the
 * durations as bars; a toast entering with full, then reduced motion; each
 * component built and playing its own motion beside its curve; the curves
 * and durations beside the components.
 */
export function MotionHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(MOTION_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

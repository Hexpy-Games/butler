import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { focusBuilds } from "./focusBuilds";
import { FOCUS_COPY, type FocusCopy } from "./focusCopy";
import { focusPrelude } from "./focusPrelude";
import { FocusCloseUp, FocusField } from "./FocusScenes";
import s from "./FocusHero.module.css";

/** The poster is laid out 1.2 times larger so the row and the four builds fill the frame. */
const POSTER_ZOOM = 1.2;

function spec(copy: FocusCopy): ChapterSpec {
  return {
    code: "focus",
    prelude: {
      ...focusPrelude(copy),
      cells: ["intro", "field", "closeup"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, closeup: <FocusCloseUp copy={copy} /> },
    },
    field: (g) => <FocusField copy={copy} g={g} />,
    fieldColumns: 6,
    posterZoom: POSTER_ZOOM,
    product: s.product!,
    builds: focusBuilds(copy),
  };
}

/**
 * 07 Focus ring, "one ring, moved by the keyboard": the intent; the Tab key
 * walks one accent ring through a row of real controls; a close-up names its
 * width and color; Shift+Tab walks it back; each component receives the ring
 * with its badge; the row and the focus tokens beside them.
 */
export function FocusHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(FOCUS_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

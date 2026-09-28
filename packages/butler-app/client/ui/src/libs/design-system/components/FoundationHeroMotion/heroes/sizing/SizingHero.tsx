import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { sizingBuilds } from "./sizingBuilds";
import { SIZING_COPY, type SizingCopy } from "./sizingCopy";
import { sizingPrelude } from "./sizingPrelude";
import { SizingField, SizingFrame } from "./SizingScenes";
import s from "./SizingHero.module.css";

function spec(copy: SizingCopy): ChapterSpec {
  return {
    code: "sizing",
    prelude: {
      ...sizingPrelude(copy),
      cells: ["intro", "field", "frame"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, frame: (g) => <SizingFrame g={g} /> },
    },
    field: (g) => <SizingField copy={copy} g={g} />,
    fieldColumns: 5,
    posterZoom: 1.2,
    product: s.product!,
    builds: sizingBuilds(copy),
  };
}

/**
 * 04 Sizing, "everything sits on the control-height scale": the intent;
 * four rails draw and real controls snap onto them; hit areas bloom and
 * grow for touch; the app frame's titlebar and sidebar rows are measured;
 * components by topic with height brackets; the rails beside them.
 */
export function SizingHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(SIZING_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

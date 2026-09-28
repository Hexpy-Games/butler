import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { spacingBuilds } from "./spacingBuilds";
import { SPACING_COPY, type SpacingCopy } from "./spacingCopy";
import { spacingPrelude } from "./spacingPrelude";
import { SpacingField, SpacingWire } from "./SpacingScenes";
import s from "./SpacingHero.module.css";

function spec(copy: SpacingCopy): ChapterSpec {
  return {
    code: "spacing",
    prelude: {
      ...spacingPrelude(copy),
      cells: ["intro", "field", "wire"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, wire: (g) => <SpacingWire copy={copy} g={g} /> },
    },
    field: <SpacingField />,
    fieldColumns: 4,
    posterZoom: 1.2,
    product: s.product!,
    builds: spacingBuilds(copy),
  };
}

/**
 * 03 Spacing, "rhythm on the 4px grid": the intent; the baseline grid draws
 * and the camera pushes into one cell; the named steps extrude as a
 * staircase; a settings wireframe is measured gap by gap and breathes
 * compact and back; components by topic (inset, stack, inline, section
 * rhythm) with their spaces hatched and named; the staircase beside them.
 */
export function SpacingHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(SPACING_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

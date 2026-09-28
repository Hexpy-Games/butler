import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { iconBuilds } from "./iconBuilds";
import { ICON_COPY, type IconCopy } from "./iconCopy";
import { iconPrelude } from "./iconPrelude";
import { IconField, IconLab } from "./IconScenes";
import s from "./IconHero.module.css";

function spec(copy: IconCopy): ChapterSpec {
  return {
    code: "icon",
    prelude: {
      ...iconPrelude(copy),
      cells: ["intro", "lab", "field"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, lab: <IconLab copy={copy} /> },
    },
    field: <IconField copy={copy} />,
    fieldScene: <IconField copy={copy} />,
    fieldColumns: 5,
    posterZoom: 1.2,
    product: s.product!,
    builds: iconBuilds(copy),
  };
}

/**
 * 06 Iconography, "six sizes, paired with type": the intent; a glyph drawn
 * stroke by stroke on its keyline grid; the six sizes on their boxes, each
 * meeting its type on one centre line; the glyphs recolor muted → primary →
 * accent; components by topic with size badges; the size ladder beside them.
 */
export function IconHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(ICON_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

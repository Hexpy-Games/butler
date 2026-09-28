import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { layoutBuilds } from "./layoutBuilds";
import { LAYOUT_COPY, type LayoutCopy } from "./layoutCopy";
import { layoutPrelude } from "./layoutPrelude";
import { LayoutField, LayoutResize } from "./LayoutScenes";
import s from "./LayoutHero.module.css";

function spec(copy: LayoutCopy): ChapterSpec {
  return {
    code: "layout",
    prelude: {
      ...layoutPrelude(copy),
      cells: ["intro", "field", "resize"],
      regions: { intro: <Intro lead={copy.lead} title={copy.title} />, resize: <LayoutResize copy={copy} /> },
    },
    field: <LayoutField />,
    fieldColumns: 4,
    // Whole screens: the poster is laid out smaller so the shells fit beside the field (and down the portrait column).
    posterZoom: 0.75,
    tallPosterZoom: 0.6,
    product: s.product!,
    builds: layoutBuilds(copy),
  };
}

/**
 * 10 Layout and platform, "one shell, three modes": the intent; the page
 * frame draws (titlebar, max width, columns and gutter, safe areas); a
 * handle drags it from 1280 to 375 through the modes, the sidebar becoming
 * a drawer; whole screens build at a lower zoom; the frame beside them.
 */
export function LayoutHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(LAYOUT_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

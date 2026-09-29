import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import { posterZoom } from "../shared/timeline";
import { Intro } from "../shared/Intro";
import type { ChapterSpec } from "../shared/types";
import { colorBuilds } from "./colorBuilds";
import { COLOR_COPY, type ColorCopy } from "./colorCopy";
import { colorPrelude } from "./colorPrelude";
import { ColorField } from "./ColorScenes";
import s from "./ColorHero.module.css";

/** The poster is laid out 1.2 times larger so the field and the four topics fill the frame. */
const POSTER_ZOOM = 1.2;

function spec(copy: ColorCopy): ChapterSpec {
  return {
    code: "color",
    prelude: { ...colorPrelude(copy, (layout) => posterZoom({ posterZoom: POSTER_ZOOM } as ChapterSpec, layout)), cells: ["intro", "field"], regions: { intro: <Intro lead={copy.lead} title={copy.title} /> } },
    field: <ColorField />,
    fieldColumns: 6,
    // The finale: the swatch field on the left, the four topics stacked on the right; portrait, the components.
    finale: { columns: [["field"], ["contrast", "action", "status", "states"]], tall: "product", frame: "packed" },
    posterZoom: POSTER_ZOOM,
    // Portrait: a little smaller, so the swatch names fit beside their stickers.
    tallPosterZoom: 1.2,
    product: s.product!,
    builds: colorBuilds(copy),
  };
}

/**
 * 01 Color. The owner's storyboard: "Color" and the color intent; the camera
 * glides on to the page and turns to a quarter view where role stickers land diagonal by diagonal and
 * take their token names; back to the front, a line wipes the field into the
 * dark theme; components are built topic by topic (contrast, action,
 * status, states), outlined first, then filled one color at a time with a
 * badge saying what each color is for; the finale sets the swatch field
 * beside the components, straight on the page.
 */
export function ColorHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(COLOR_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

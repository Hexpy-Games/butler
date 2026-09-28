import { useMemo } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { ChapterHero } from "../shared/ChapterHero";
import type { ChapterSpec } from "../shared/types";
import { colorBuilds } from "./colorBuilds";
import { COLOR_COPY, type ColorCopy } from "./colorCopy";
import { colorPrelude } from "./colorPrelude";
import { ColorField, ColorIntro } from "./ColorScenes";
import s from "./ColorHero.module.css";

function spec(copy: ColorCopy): ChapterSpec {
  return {
    code: "color",
    prelude: { ...colorPrelude(copy), render: <ColorIntro copy={copy} /> },
    field: <ColorField />,
    fieldColumns: 6,
    posterZoom: 1.2,
    product: s.product!,
    builds: colorBuilds(copy),
  };
}

/**
 * 01 Color. The owner's storyboard: "Color" and the color intent; the camera
 * turns to a quarter view where role stickers land diagonal by diagonal and
 * take their token names; back to the front, a line wipes the field into the
 * dark theme; components are built topic by topic (contrast, action,
 * status, states), outlined first, then filled one color at a time with a
 * badge saying what each color is for; the finale packs the swatch field
 * beside the components.
 */
export function ColorHero({ lang }: { lang: FoundationHeroLang }) {
  const chapter = useMemo(() => spec(COLOR_COPY[lang]), [lang]);
  return <ChapterHero lang={lang} spec={chapter} />;
}

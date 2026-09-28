import { Button } from "../../components/Button";
import { ChapterLayout, chapterSections, GuideSection } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import { TypeInContext } from "./TypeInContext";
import { TypeLadder } from "./TypeLadder";
import { KoreanRules, MeasureAndLeading, Numerals, Truncation } from "./TypeRules";
import { TypeFace } from "./TypeFace";

export function TypographyChapter({ chapter, locale, anchor, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [
    ["typeface", "Typeface"], ["type-scale", "Type scale"], ["hierarchy", "Hierarchy in context"], ["korean", "Korean typography"],
    ["measure", "Measure and leading"], ["truncation", "Truncation"], ["numerals", "Numerals"],
  ]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="One voice across Latin and Hangul: one font stack, a role scale instead of raw sizes, and four calm weights. Pick the role for the job; the role owns size, leading, weight and tracking."
      headerExtra={<Button size="xs" variant="borderless" text="Typo component" onClick={() => onOpen("components/Typo")} />}>
      <GuideSection spec={s.at("typeface")} lead="Shown from the current --font-body and --font-family-code stacks in tokens.css; the page follows them when they change.">
        <TypeFace locale={locale} />
      </GuideSection>
      <GuideSection spec={s.at("type-scale")} lead="Every --typo-* role, set in its own style. The spec on the right is read from the rendered sample.">
        <TypeLadder locale={locale} />
      </GuideSection>
      <GuideSection spec={s.at("hierarchy")} lead="Real Butler surfaces. Each number is the role that text is set in; sizes are measured.">
        <TypeInContext locale={locale} />
      </GuideSection>
      <GuideSection spec={s.at("korean")} lead="Hangul sets untracked, breaks between words and shares one stack with Latin and numbers.">
        <KoreanRules />
      </GuideSection>
      <GuideSection spec={s.at("measure")} lead="Long text sits in a reading column with document leading; UI text keeps body leading.">
        <MeasureAndLeading locale={locale} />
      </GuideSection>
      <GuideSection spec={s.at("truncation")} lead="Typo truncates and clamps; it never lets a long token push the layout wider.">
        <Truncation locale={locale} />
      </GuideSection>
      <GuideSection spec={s.at("numerals")} lead="Figures that line up in a column, and times formatted for the locale.">
        <Numerals locale={locale} />
      </GuideSection>
    </ChapterLayout>
  );
}

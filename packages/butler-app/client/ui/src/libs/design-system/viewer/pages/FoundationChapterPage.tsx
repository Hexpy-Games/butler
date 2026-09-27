import type { ComponentType } from "react";
import type { ChapterProps } from "../foundations/chapterProps";
import type { FoundationChapter, FoundationChapterId } from "../foundations/chapters";
import { ColorChapter } from "../foundations/ColorChapter";
import { FocusChapter, IconographyChapter, LayersChapter, LayoutChapter } from "../foundations/ReferenceChapters";
import { ShapeChapter } from "../foundations/ShapeChapter";
import { SizingChapter } from "../foundations/SizingChapter";
import { SpacingChapter } from "../foundations/SpacingChapter";
import type { SampleLocale } from "../foundations/typeRoles";
import { TypographyChapter } from "../foundations/TypographyChapter";

const CHAPTER_PAGES: Record<Exclude<FoundationChapterId, "motion">, ComponentType<ChapterProps>> = {
  color: ColorChapter,
  typography: TypographyChapter,
  spacing: SpacingChapter,
  sizing: SizingChapter,
  radius: ShapeChapter,
  iconography: IconographyChapter,
  focus: FocusChapter,
  "z-index": LayersChapter,
  layout: LayoutChapter,
};

export function FoundationChapterPage({ chapter, locale, anchor, onOpen }: {
  chapter: FoundationChapter;
  locale: SampleLocale;
  anchor?: string;
  onOpen: (page: string) => void;
}) {
  const Page = CHAPTER_PAGES[chapter.id as Exclude<FoundationChapterId, "motion">] ?? ColorChapter;
  return <Page anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} />;
}

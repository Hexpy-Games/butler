import type { FoundationChapter } from "./chapters";
import type { SampleLocale } from "./typeRoles";

export interface ChapterProps {
  chapter: FoundationChapter;
  locale: SampleLocale;
  /** In-page anchor of the current navigation (token rows open the token table). */
  anchor?: string;
  onOpen: (page: string) => void;
}

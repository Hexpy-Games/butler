import { DEFAULT_LOCALE, LOCALES, SECTIONS, type Locale, type SectionId } from "./sections";

export type DocStatus = "published" | "planned";

/** The part of a docs collection entry the navigation needs. */
export interface DocEntryLike {
  id: string;
  data: { title: string; description: string; section: SectionId; order: number; status: DocStatus };
}

export interface NavRowItem {
  slug: string;
  label: string;
  /** null for planned pages: rendered as disabled rows, never as links. */
  href: string | null;
  active: boolean;
  planned: boolean;
}

export interface NavSectionItem {
  id: SectionId;
  title: string;
  /** A one-page section whose page shares its title renders as a bare row. */
  flat: boolean;
  rows: NavRowItem[];
}

export interface PageContext {
  section?: NavSectionItem;
  row?: NavRowItem;
  prev?: NavRowItem;
  next?: NavRowItem;
}

export function withBase(base: string, path: string): string {
  return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

export function docLocale(id: string): string {
  return id.split("/")[0] ?? "";
}

export function docSlug(id: string): string {
  return id.split("/").slice(1).join("/");
}

/** The manual lives under /help/ (/<locale>/help/ for other locales); the site root is kept for an intro page. */
export const MANUAL_SEGMENT = "help";

export function docsRoot(base: string, locale: Locale): string {
  return withBase(base, locale === DEFAULT_LOCALE ? `${MANUAL_SEGMENT}/` : `${locale}/${MANUAL_SEGMENT}/`);
}

/** The DS Viewer (packages/butler-app/client/ui ds-site build), added to the site by scripts/build-ds.ts. */
export function designSystemRoot(base: string): string {
  return withBase(base, "ds/");
}

/**
 * Emitted by the DS site build at <ds root>; the site's 404.html loads it to
 * forward path-style /ds/<page> links to ?page= (it ignores other paths).
 * See packages/butler-app/client/ui/ds-site/README.md.
 */
export const DS_REDIRECT_HELPER = "ds-404-redirect.js";

export function docHref(base: string, locale: Locale, slug: string): string {
  return withBase(docsRoot(base, locale), `${slug}/`);
}

/**
 * A page in every locale, for hreflang links and the language switcher: null
 * where that translation is not published. `slug` null is the manual's
 * landing page, which every locale has.
 */
export function localeAlternates(entries: DocEntryLike[], base: string, slug: string | null): Record<Locale, string | null> {
  const result = {} as Record<Locale, string | null>;
  for (const locale of LOCALES) {
    const published = entries.some((entry) => entry.id === `${locale}/${slug}` && entry.data.status === "published");
    result[locale] = slug === null ? docsRoot(base, locale) : published ? docHref(base, locale, slug) : null;
  }
  return result;
}

/** Where the switcher sends a reader: the same page, or that locale's landing page when it has no translation. */
export function switchHref(alternates: Partial<Record<Locale, string | null>>, base: string, locale: Locale): string {
  return alternates[locale] ?? docsRoot(base, locale);
}

export function buildNav(
  entries: DocEntryLike[],
  options: { locale: Locale; base: string; currentSlug: string },
): NavSectionItem[] {
  const local = entries.filter((entry) => docLocale(entry.id) === options.locale);
  return SECTIONS.flatMap((section) => {
    const rows = local
      .filter((entry) => entry.data.section === section.id)
      .sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title))
      .map((entry): NavRowItem => {
        const slug = docSlug(entry.id);
        const planned = entry.data.status === "planned";
        return {
          slug,
          label: entry.data.title,
          href: planned ? null : docHref(options.base, options.locale, slug),
          active: slug === options.currentSlug,
          planned,
        };
      });
    if (rows.length === 0) return [];
    const title = section.title[options.locale];
    return [{ id: section.id, title, flat: rows.length === 1 && rows[0].label === title, rows }];
  });
}

export function pageContext(nav: NavSectionItem[], slug: string): PageContext {
  const published = nav.flatMap((section) => section.rows.filter((row) => !row.planned));
  const index = published.findIndex((row) => row.slug === slug);
  const section = nav.find((candidate) => candidate.rows.some((row) => row.slug === slug));
  return {
    section,
    row: section?.rows.find((row) => row.slug === slug),
    prev: index > 0 ? published[index - 1] : undefined,
    next: index >= 0 ? published[index + 1] : undefined,
  };
}

export interface NavBlock {
  key: string;
  title: string;
  hideTitle: boolean;
  sections: NavSectionItem[];
}

/** Consecutive one-page sections read as one untitled group of rows. */
export function navBlocks(sections: NavSectionItem[]): NavBlock[] {
  const blocks: NavBlock[] = [];
  for (const section of sections) {
    const last = blocks.at(-1);
    if (section.flat && last?.hideTitle) {
      last.sections.push(section);
      last.title = `${last.title} · ${section.title}`;
      last.key = `${last.key}+${section.id}`;
      continue;
    }
    blocks.push({ key: section.id, title: section.title, hideTitle: section.flat, sections: [section] });
  }
  return blocks;
}

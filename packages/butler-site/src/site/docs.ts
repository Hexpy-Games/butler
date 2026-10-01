import { getCollection } from "astro:content";
import { buildNav, docHref, docLocale, docsRoot, docSlug, type NavSectionItem } from "./nav";
import { LOCALES, type Locale } from "./sections";

export async function localeEntries(locale: Locale) {
  return getCollection("docs", (entry) => docLocale(entry.id) === locale);
}

export async function publishedEntries(locale: Locale) {
  return (await localeEntries(locale)).filter((entry) => entry.data.status === "published");
}

export async function loadNav(locale: Locale, currentSlug: string): Promise<NavSectionItem[]> {
  return buildNav(await localeEntries(locale), { locale, base: import.meta.env.BASE_URL, currentSlug });
}

/** This page in every locale; null where that translation is not published. */
export async function alternates(slug: string | null): Promise<Record<Locale, string | null>> {
  const base = import.meta.env.BASE_URL;
  const all = await getCollection("docs", (entry) => entry.data.status === "published");
  const result = {} as Record<Locale, string | null>;
  for (const locale of LOCALES) {
    const published = all.filter((entry) => docLocale(entry.id) === locale);
    if (slug === null) result[locale] = published.length > 0 ? docsRoot(base, locale) : null;
    else result[locale] = published.some((entry) => docSlug(entry.id) === slug) ? docHref(base, locale, slug) : null;
  }
  return result;
}

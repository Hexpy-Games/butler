import { getCollection } from "astro:content";
import { buildNav, docLocale, localeAlternates, type NavSectionItem } from "./nav";
import type { Locale } from "./sections";

export async function localeEntries(locale: Locale) {
  return getCollection("docs", (entry) => docLocale(entry.id) === locale);
}

export async function publishedEntries(locale: Locale) {
  return (await localeEntries(locale)).filter((entry) => entry.data.status === "published");
}

export async function loadNav(locale: Locale, currentSlug: string): Promise<NavSectionItem[]> {
  return buildNav(await localeEntries(locale), { locale, base: import.meta.env.BASE_URL, currentSlug });
}

/** This page in every locale (null slug: the landing page); null where that translation is not published. */
export async function alternates(slug: string | null): Promise<Record<Locale, string | null>> {
  return localeAlternates(await getCollection("docs"), import.meta.env.BASE_URL, slug);
}

/**
 * Source-level link check for docs MDX: DocCard slugs, markdown links and
 * href attributes must point at published pages (and existing headings).
 * Internal links are written root-relative as /help/<slug>/ in Korean pages
 * and /en/help/<slug>/ in English pages (the build adds the base path, see
 * baseLinks.ts); a DocCard slug resolves in the locale of its page.
 *
 * Translation checks compare a locale with the default one: every page needs
 * a source page with the same section and order (checkTranslationSources),
 * and a complete locale has every published page with the same outline, cards
 * and internal links (translationGaps).
 */
import { docLocale, docSlug, docsRoot } from "./nav";
import { DEFAULT_LOCALE, type Locale } from "./sections";

export interface DocSource {
  /** Collection id: <locale>/<slug>. */
  id: string;
  source: string;
}

export interface DocLink {
  target: string;
  line: number;
}

const FENCE = /^\s*(```|~~~)/u;
const CARD_SLUG = /<DocCard\b[^>]*\bslug="([^"]+)"/gu;
const MARKDOWN_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;
const HREF = /\bhref="([^"]+)"/gu;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end < 0 ? 0 : end + 1;
}

/** Body lines outside frontmatter and fenced code, with 1-based line numbers. */
function proseLines(source: string): Array<{ text: string; line: number }> {
  const lines = source.split("\n");
  const result: Array<{ text: string; line: number }> = [];
  let fence: string | null = null;
  lines.forEach((text, index) => {
    if (index < frontmatterEnd(lines)) return;
    const marker = FENCE.exec(text)?.[1];
    if (marker) {
      fence = fence === null ? marker : fence === marker ? null : fence;
      return;
    }
    if (fence === null) result.push({ text, line: index + 1 });
  });
  return result;
}

function frontmatterValue(source: string, key: string): string | undefined {
  const lines = source.split("\n");
  for (const line of lines.slice(1, frontmatterEnd(lines) - 1)) {
    const match = new RegExp(`^${key}:\\s*(.*)$`, "u").exec(line.trim());
    if (match) return match[1].replace(/^["']|["']$/gu, "");
  }
  return undefined;
}

/** github-slugger, as Astro uses for heading ids: lowercase, drop punctuation, spaces to "-". */
export function slugifyHeading(text: string): string {
  const plain = text.replace(/`([^`]*)`/gu, "$1").replace(/\*+/gu, "").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
  return plain.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /gu, "-");
}

export function headingIds(source: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text } of proseLines(source)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(text);
    if (!match) continue;
    const base = slugifyHeading(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

export function docLinks(source: string, locale: Locale = DEFAULT_LOCALE): DocLink[] {
  const links: DocLink[] = [];
  for (const { text, line } of proseLines(source)) {
    const prose = text.replace(/`[^`]*`/gu, "");
    for (const match of prose.matchAll(CARD_SLUG)) links.push({ target: `${docsRoot("/", locale)}${match[1]}/`, line });
    for (const pattern of [MARKDOWN_LINK, HREF]) {
      for (const match of prose.matchAll(pattern)) {
        if (!EXTERNAL.test(match[1])) links.push({ target: match[1], line });
      }
    }
  }
  return links;
}

function docsPrefix(locale: string): string {
  return docsRoot("/", locale as Locale);
}

function isPublished(doc: DocSource | undefined): boolean {
  return doc !== undefined && frontmatterValue(doc.source, "status") === "published";
}

/**
 * One problem string per broken internal link in published pages. A locale
 * listed in `inProgress` may link to a page it has not published yet when the
 * default locale publishes that page (translationGaps reports the page).
 */
export function checkDocLinks(docs: DocSource[], inProgress: readonly string[] = []): string[] {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const problems: string[] = [];
  for (const doc of docs) {
    if (frontmatterValue(doc.source, "status") !== "published") continue;
    const locale = docLocale(doc.id);
    const prefix = docsPrefix(locale);
    const awaited = (slug: string) =>
      inProgress.includes(locale) && !isPublished(byId.get(`${locale}/${slug}`)) && isPublished(byId.get(`${DEFAULT_LOCALE}/${slug}`));
    for (const { target, line } of docLinks(doc.source, locale as Locale)) {
      const report = (reason: string) => problems.push(`${doc.id}:${line} ${target}: ${reason}`);
      const [path, anchor] = target.split("#", 2) as [string, string | undefined];
      let targetDoc: DocSource | undefined = doc;
      if (path !== "") {
        if (!path.startsWith(prefix) || !path.endsWith("/")) {
          report(`internal links are ${prefix}<slug>/`);
          continue;
        }
        const slug = path.slice(prefix.length, -1);
        if (awaited(slug)) continue;
        targetDoc = byId.get(`${locale}/${slug}`);
        if (!targetDoc) {
          report("no docs page");
          continue;
        }
        if (frontmatterValue(targetDoc.source, "status") !== "published") {
          report("page is planned");
          continue;
        }
      }
      if (anchor !== undefined && !headingIds(targetDoc.source).has(decodeURIComponent(anchor))) {
        report(`no heading #${anchor}`);
      }
    }
  }
  return problems;
}

/** Lines (frontmatter included) that use a banned term; a RegExp term reports what it matched. */
export function findTerms(docs: DocSource[], terms: Array<string | RegExp>): string[] {
  return docs.flatMap((doc) =>
    doc.source.split("\n").flatMap((text, index) =>
      terms.flatMap((term) => {
        const found = typeof term === "string" ? (text.includes(term) ? term : undefined) : term.exec(text)?.[0];
        return found === undefined ? [] : [`${doc.id}:${index + 1} ${found}: ${text.trim()}`];
      })));
}

// ---------------------------------------------------------------- translations

function localeDocs(docs: DocSource[], locale: string): Map<string, DocSource> {
  return new Map(docs.filter((doc) => docLocale(doc.id) === locale).map((doc) => [docSlug(doc.id), doc]));
}

/**
 * Always enforced: a translated page mirrors a default-locale page (same
 * slug, section and order) and is not published ahead of it.
 */
export function checkTranslationSources(docs: DocSource[], locale: Locale): string[] {
  const sources = localeDocs(docs, DEFAULT_LOCALE);
  const problems: string[] = [];
  for (const [slug, doc] of localeDocs(docs, locale)) {
    const source = sources.get(slug);
    if (!source) {
      problems.push(`${doc.id}: no ${DEFAULT_LOCALE}/${slug} page to translate; slugs mirror the ${DEFAULT_LOCALE} pages`);
      continue;
    }
    for (const key of ["section", "order"]) {
      const [mine, theirs] = [frontmatterValue(doc.source, key), frontmatterValue(source.source, key)];
      if (mine !== theirs) problems.push(`${doc.id}: ${key} is ${mine}, ${source.id} has ${theirs}`);
    }
    if (isPublished(doc) && !isPublished(source)) problems.push(`${doc.id}: published, but ${source.id} is planned`);
  }
  return problems;
}

const COMPONENT_TAG = /<(Steps|Notice|Tabs|TabPanel|CardGrid|DocCard|Kbd)\b/gu;
/** ASCII URL characters only, so a particle glued to a URL (https://example.com을) is not part of it. */
const EXTERNAL_URL = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/gu;

/**
 * Anchored links as "<slug> heading <n>": the position of the linked heading
 * in its page. Heading text is translated, so positions are what two locales
 * can compare; "heading 0" is an anchor that matches no heading.
 */
function anchorTargets(doc: DocSource, locale: Locale, pages: Map<string, DocSource>): string[] {
  const prefix = docsRoot("/", locale);
  return docLinks(doc.source, locale).flatMap(({ target }) => {
    const [path, anchor] = target.split("#", 2) as [string, string | undefined];
    if (anchor === undefined) return [];
    const slug = path === "" ? docSlug(doc.id) : path.startsWith(prefix) ? path.slice(prefix.length).replace(/\/$/u, "") : path;
    const page = pages.get(slug);
    const position = page ? [...headingIds(page.source)].indexOf(decodeURIComponent(anchor)) + 1 : 0;
    return [`${slug} heading ${position}`];
  });
}

/** What a translation keeps from its source: outline, components, code blocks and link targets. */
function pageShape(doc: DocSource, locale: Locale, pages: Map<string, DocSource>) {
  const { source } = doc;
  const lines = source.split("\n");
  const body = lines.slice(frontmatterEnd(lines));
  const prose = proseLines(source);
  const counts = new Map<string, number>();
  for (const { text } of prose) {
    for (const match of text.matchAll(COMPONENT_TAG)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  const fences = body.filter((line) => FENCE.test(line)).length;
  if (fences > 0) counts.set("code block", Math.ceil(fences / 2));
  const prefix = docsRoot("/", locale);
  const unique = (values: string[]) => [...new Set(values)].sort();
  return {
    outline: prose.flatMap(({ text }) => /^(#{1,6})\s/u.exec(text)?.[1].length ?? []).join(" "),
    components: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, total]) => `${name}×${total}`).join(", "),
    links: unique(docLinks(source, locale).flatMap(({ target }) => {
      const path = target.split("#", 1)[0];
      return path === "" ? [] : [path.startsWith(prefix) ? path.slice(prefix.length).replace(/\/$/u, "") : path];
    })),
    anchors: unique(anchorTargets(doc, locale, pages)),
    urls: unique(body.flatMap((line) => line.match(EXTERNAL_URL) ?? []).map((url) => url.replace(/[.,;:!?]+$/u, ""))),
  };
}

/** "missing a, b; extra c" for two sorted lists, or "" when they match. */
function listDifference(mine: string[], theirs: string[]): string {
  const missing = theirs.filter((value) => !mine.includes(value));
  const extra = mine.filter((value) => !theirs.includes(value));
  return [missing.length > 0 ? `missing ${missing.join(", ")}` : "", extra.length > 0 ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ");
}

/**
 * What a locale still lacks against the default locale: published pages that
 * are missing or planned, and published translations whose heading outline,
 * components, code blocks or link targets differ from their source. Anchors
 * are compared by the position of the heading they point at, so a link that
 * drops its #anchor, or points at another section, is reported. Reported
 * while the locale is in progress; a failure once it is in COMPLETE_LOCALES.
 */
export function translationGaps(docs: DocSource[], locale: Locale): string[] {
  const translated = localeDocs(docs, locale);
  const sources = localeDocs(docs, DEFAULT_LOCALE);
  const gaps: string[] = [];
  for (const [slug, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isPublished(source)) continue;
    const doc = translated.get(slug);
    if (!doc || !isPublished(doc)) {
      gaps.push(`${locale}/${slug}: ${doc ? "planned, not translated yet" : "missing"}`);
      continue;
    }
    const [mine, theirs] = [pageShape(doc, locale, translated), pageShape(source, DEFAULT_LOCALE, sources)];
    for (const key of ["outline", "components"] as const) {
      if (mine[key] !== theirs[key]) gaps.push(`${doc.id}: ${key} differ from ${source.id} (${locale}: ${mine[key] || "none"} | ${DEFAULT_LOCALE}: ${theirs[key] || "none"})`);
    }
    for (const key of ["links", "anchors", "urls"] as const) {
      const difference = listDifference(mine[key], theirs[key]);
      if (difference) gaps.push(`${doc.id}: ${key} differ from ${source.id} (${difference})`);
    }
  }
  return gaps;
}


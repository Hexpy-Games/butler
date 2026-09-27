/**
 * Source-level link check for docs MDX: DocCard slugs, markdown links and
 * href attributes must point at published pages (and existing headings).
 * Internal links are written root-relative as /docs/<slug>/ (the build adds
 * the base path, see baseLinks.ts).
 */
import { docLocale } from "./nav";
import { DEFAULT_LOCALE } from "./sections";

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

export function docLinks(source: string): DocLink[] {
  const links: DocLink[] = [];
  for (const { text, line } of proseLines(source)) {
    const prose = text.replace(/`[^`]*`/gu, "");
    for (const match of prose.matchAll(CARD_SLUG)) links.push({ target: `/docs/${match[1]}/`, line });
    for (const pattern of [MARKDOWN_LINK, HREF]) {
      for (const match of prose.matchAll(pattern)) {
        if (!EXTERNAL.test(match[1])) links.push({ target: match[1], line });
      }
    }
  }
  return links;
}

function docsPrefix(locale: string): string {
  return locale === DEFAULT_LOCALE ? "/docs/" : `/${locale}/docs/`;
}

/** One problem string per broken internal link in published pages. */
export function checkDocLinks(docs: DocSource[]): string[] {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const problems: string[] = [];
  for (const doc of docs) {
    if (frontmatterValue(doc.source, "status") !== "published") continue;
    const locale = docLocale(doc.id);
    const prefix = docsPrefix(locale);
    for (const { target, line } of docLinks(doc.source)) {
      const report = (reason: string) => problems.push(`${doc.id}:${line} ${target}: ${reason}`);
      const [path, anchor] = target.split("#", 2) as [string, string | undefined];
      let targetDoc: DocSource | undefined = doc;
      if (path !== "") {
        if (!path.startsWith(prefix) || !path.endsWith("/")) {
          report(`internal links are ${prefix}<slug>/`);
          continue;
        }
        const slug = path.slice(prefix.length, -1);
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

/** Lines (frontmatter included) that use a banned term. */
export function findTerms(docs: DocSource[], terms: string[]): string[] {
  return docs.flatMap((doc) =>
    doc.source.split("\n").flatMap((text, index) =>
      terms.filter((term) => text.includes(term)).map((term) => `${doc.id}:${index + 1} ${term}: ${text.trim()}`)));
}


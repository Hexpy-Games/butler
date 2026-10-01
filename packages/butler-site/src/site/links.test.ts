import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  checkDocLinks,
  checkTranslationSources,
  docLinks,
  findTerms,
  headingIds,
  slugifyHeading,
  translationGaps,
  type DocSource,
} from "./links";
import { COMPLETE_LOCALES, DEFAULT_LOCALE, LOCALES, SECTIONS } from "./sections";
import { UI } from "./ui";

const CONTENT_ROOT = join(import.meta.dir, "../content/docs");

function page(id: string, body: string, status: "published" | "planned" = "published"): DocSource {
  return { id, source: `---\ntitle: "${id}"\ndescription: "d"\nsection: basics\norder: 1\nstatus: ${status}\n---\n\n${body}\n` };
}

function contentDocs(dir = CONTENT_ROOT): DocSource[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return contentDocs(path);
    if (!name.endsWith(".mdx")) return [];
    return [{ id: relative(CONTENT_ROOT, path).replace(/\.mdx$/u, ""), source: readFileSync(path, "utf8") }];
  });
}

describe("slugifyHeading", () => {
  test("matches the heading ids Astro renders", () => {
    expect(slugifyHeading("파일 확인 (선택)")).toBe("파일-확인-선택");
    expect(slugifyHeading("앱 없이 Agent만 쓰기")).toBe("앱-없이-agent만-쓰기");
    expect(slugifyHeading("SKILL.md 형식")).toBe("skillmd-형식");
    expect(slugifyHeading("설치 점검: `doctor`")).toBe("설치-점검-doctor");
    expect(slugifyHeading("**권한** 메뉴")).toBe("권한-메뉴");
  });
});

describe("headingIds", () => {
  test("numbers repeated headings and skips fenced code", () => {
    const ids = headingIds("## 관련 문서\n\n```markdown\n## Instructions\n```\n\n### 관련 문서\n");
    expect([...ids]).toEqual(["관련-문서", "관련-문서-1"]);
  });
});

describe("docLinks", () => {
  test("collects cards, markdown links and hrefs outside code", () => {
    const links = docLinks([
      '<DocCard slug="models/cloud" />',
      "[Custom 모델](/help/models/custom/#연결하기)과 [외부](https://example.com)",
      '<DocCard href="https://github.com" title="t" description="d" />',
      "`[코드](/help/nope/)`",
      "```md",
      "[펜스](/help/fenced/)",
      "```",
      "[같은 문서](#연결하기)",
    ].join("\n"));
    expect(links.map((link) => [link.target, link.line])).toEqual([
      ["/help/models/cloud/", 1],
      ["/help/models/custom/#연결하기", 2],
      ["#연결하기", 8],
    ]);
  });
});

describe("checkDocLinks", () => {
  const docs = [
    page("ko/models/cloud", "## 모델 등록하기\n\n[없는 문서](/help/models/nope/)\n[예정 문서](/help/models/backup/)"),
    page("ko/models/custom", "## 연결하기\n\n[기본 모델](/help/models/cloud/#모델-등록하기)\n[없는 제목](/help/models/cloud/#없음)"),
    page("ko/models/backup", "", "planned"),
    page("ko/basics/conversation", "[슬래시 없음](/help/models/cloud)\n[상대](../models/cloud/)\n[같은 문서](#없는-제목)\n<DocCard slug=\"models/backup\" />\n[옛 경로](/docs/models/cloud/)"),
  ];

  test("accepts published pages and existing anchors", () => {
    const valid = [
      page("ko/a", "## 모델 등록하기\n\n[b](/help/b/#연결하기)\n<DocCard slug=\"b\" />"),
      page("ko/b", "## 연결하기\n\n[a](/help/a/#모델-등록하기)\n[여기](#연결하기)"),
    ];
    expect(checkDocLinks(valid)).toEqual([]);
  });

  test("flags missing, planned, relative, slash-less and legacy /docs/ targets", () => {
    expect(checkDocLinks(docs)).toEqual([
      "ko/models/cloud:11 /help/models/nope/: no docs page",
      "ko/models/cloud:12 /help/models/backup/: page is planned",
      "ko/models/custom:12 /help/models/cloud/#없음: no heading #없음",
      "ko/basics/conversation:9 /help/models/cloud: internal links are /help/<slug>/",
      "ko/basics/conversation:10 ../models/cloud/: internal links are /help/<slug>/",
      "ko/basics/conversation:11 #없는-제목: no heading #없는-제목",
      "ko/basics/conversation:12 /help/models/backup/: page is planned",
      "ko/basics/conversation:13 /docs/models/cloud/: internal links are /help/<slug>/",
    ]);
  });
});

describe("English pages", () => {
  test("link under /en/help/ and resolve cards in their own locale", () => {
    const docs = [
      page("ko/a", "## 연결하기"),
      page("ko/b", ""),
      page("en/a", "## Connect\n\n[b](/en/help/b/)\n<DocCard slug=\"b\" />\n[here](#connect)"),
      page("en/b", "[a](/en/help/a/#connect)\n[Korean page](/help/a/)\n[Korean anchor](/en/help/a/#연결하기)"),
    ];
    expect(docLinks(docs[2].source, "en").map((link) => link.target)).toEqual(["/en/help/b/", "/en/help/b/", "#connect"]);
    expect(checkDocLinks(docs)).toEqual([
      "en/b:10 /help/a/: internal links are /en/help/<slug>/",
      "en/b:11 /en/help/a/#연결하기: no heading #연결하기",
    ]);
  });

  test("a locale in progress may link to pages it has not translated yet", () => {
    const docs = [
      page("ko/a", ""),
      page("ko/b", ""),
      page("ko/c", "", "planned"),
      page("en/a", "[b](/en/help/b/#later)\n<DocCard slug=\"b\" />\n[c](/en/help/c/)\n[nope](/en/help/nope/)"),
      page("en/b", "", "planned"),
    ];
    expect(checkDocLinks(docs, ["en"])).toEqual([
      "en/a:11 /en/help/c/: no docs page",
      "en/a:12 /en/help/nope/: no docs page",
    ]);
    expect(checkDocLinks(docs)).toEqual([
      "en/a:9 /en/help/b/#later: page is planned",
      "en/a:10 /en/help/b/: page is planned",
      "en/a:11 /en/help/c/: no docs page",
      "en/a:12 /en/help/nope/: no docs page",
    ]);
  });
});

describe("checkTranslationSources", () => {
  test("a translation mirrors a Korean page: slug, section, order, and not published first", () => {
    const docs = [
      page("ko/a", ""),
      page("ko/b", "", "planned"),
      page("en/a", ""),
      page("en/b", ""),
      page("en/extra", ""),
      { id: "en/a2", source: page("en/a2", "").source.replace("order: 1", "order: 2") },
      page("ko/a2", ""),
    ];
    expect(checkTranslationSources(docs, "en")).toEqual([
      "en/b: published, but ko/b is planned",
      "en/extra: no ko/extra page to translate; slugs mirror the ko pages",
      "en/a2: order is 2, ko/a2 has 1",
    ]);
  });
});

describe("translationGaps", () => {
  const source = [
    "## 설치",
    "",
    "<Steps>",
    "  1. [릴리스](https://example.com/releases)를 엽니다.",
    "</Steps>",
    "",
    "```bash",
    "butler doctor",
    "```",
    "",
    "### 확인",
    "",
    "[첫 실행](/help/first-run/#준비)을 참고합니다.",
    "<DocCard slug=\"models\" />",
  ].join("\n");

  test("accepts a translation with the same outline, components, code blocks and links", () => {
    const translated = [
      "## Install",
      "",
      "<Steps>",
      "  1. Open the [release](https://example.com/releases).",
      "</Steps>",
      "",
      "```bash",
      "butler doctor",
      "```",
      "",
      "### Verify",
      "",
      "See [First run](/en/help/first-run/#before-you-start).",
      "<DocCard slug=\"models\" />",
    ].join("\n");
    expect(translationGaps([page("ko/install", source), page("en/install", translated)], "en")).toEqual([]);
  });

  test("lists missing and planned pages, and skips planned Korean pages", () => {
    const docs = [page("ko/a", ""), page("ko/b", ""), page("ko/draft", "", "planned"), page("en/b", "", "planned")];
    expect(translationGaps(docs, "en")).toEqual(["en/a: missing", "en/b: planned, not translated yet"]);
  });

  test("reports a translation that drops a heading, a component, a code block or a link", () => {
    const translated = "## Install\n\n1. Open the [release](https://example.com/download).\n\nSee [Models](/en/help/models/).";
    const gaps = translationGaps([page("ko/install", source), page("en/install", translated)], "en");
    expect(gaps).toEqual([
      "en/install: outline differ from ko/install (en: 2 | ko: 2 3)",
      "en/install: components differ from ko/install (en: none | ko: code block×1, DocCard×1, Steps×1)",
      "en/install: links differ from ko/install (missing first-run)",
      "en/install: urls differ from ko/install (missing https://example.com/releases; extra https://example.com/download)",
    ]);
  });
});

describe("docs content", () => {
  const docs = contentDocs();
  const translations = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);
  const inProgress = translations.filter((locale) => !COMPLETE_LOCALES.includes(locale));

  test("every internal link in published pages resolves", () => {
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((doc) => doc.id.startsWith("en/"))).toBe(true);
    expect(checkDocLinks(docs, inProgress)).toEqual([]);
  });

  test("translated pages mirror a Korean page's slug, section and order", () => {
    for (const locale of translations) expect(checkTranslationSources(docs, locale)).toEqual([]);
  });

  // Until a locale is listed in COMPLETE_LOCALES (sections.ts), its gaps are
  // printed as a to-do list for translators; after that they fail the check.
  test("complete locales translate every published Korean page with the same structure", () => {
    for (const locale of translations) {
      const gaps = translationGaps(docs, locale);
      if (COMPLETE_LOCALES.includes(locale)) expect(gaps).toEqual([]);
      else if (gaps.length > 0) console.info(`Translation report (${locale}, in progress, ${gaps.length} open):\n${gaps.map((gap) => `  ${gap}`).join("\n")}`);
    }
  });

  test("English pages and labels say Schedules, never automation, and never Steward", () => {
    const banned = [/\bautomations?\b/iu, /\bstewards?\b/iu];
    expect(findTerms(docs.filter((doc) => doc.id.startsWith("en/")), banned)).toEqual([]);
    expect(SECTIONS.map((section) => section.title.en).filter((title) => banned.some((term) => term.test(title)))).toEqual([]);
    expect(banned.filter((term) => term.test(JSON.stringify(UI.en)))).toEqual([]);
  });

  test("the remote access page is published under 고급 and linked from settings and troubleshooting", () => {
    const remote = docs.find((doc) => doc.id === "ko/advanced/remote-access");
    expect(remote?.source).toContain("section: advanced");
    expect(remote?.source).toContain("status: published");
    for (const id of ["ko/settings", "ko/troubleshooting"]) {
      const source = docs.find((doc) => doc.id === id)?.source ?? "";
      expect(docLinks(source).map((link) => link.target)).toContain("/help/advanced/remote-access/");
    }
  });

  test("Korean pages use 예약 작업, never 자동화", () => {
    expect(findTerms(docs.filter((doc) => doc.id.startsWith("ko/")), ["자동화"])).toEqual([]);
    expect(SECTIONS.map((section) => section.title.ko).filter((title) => title.includes("자동화"))).toEqual([]);
  });
});

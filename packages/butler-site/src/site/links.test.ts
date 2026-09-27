import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkDocLinks, docLinks, findTerms, headingIds, slugifyHeading, type DocSource } from "./links";
import { SECTIONS } from "./sections";

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
      "[Custom 모델](/docs/models/custom/#연결하기)과 [외부](https://example.com)",
      '<DocCard href="https://github.com" title="t" description="d" />',
      "`[코드](/docs/nope/)`",
      "```md",
      "[펜스](/docs/fenced/)",
      "```",
      "[같은 문서](#연결하기)",
    ].join("\n"));
    expect(links.map((link) => [link.target, link.line])).toEqual([
      ["/docs/models/cloud/", 1],
      ["/docs/models/custom/#연결하기", 2],
      ["#연결하기", 8],
    ]);
  });
});

describe("checkDocLinks", () => {
  const docs = [
    page("ko/models/cloud", "## 모델 등록하기\n\n[없는 문서](/docs/models/nope/)\n[예정 문서](/docs/models/backup/)"),
    page("ko/models/custom", "## 연결하기\n\n[기본 모델](/docs/models/cloud/#모델-등록하기)\n[없는 제목](/docs/models/cloud/#없음)"),
    page("ko/models/backup", "", "planned"),
    page("ko/basics/conversation", "[슬래시 없음](/docs/models/cloud)\n[상대](../models/cloud/)\n[같은 문서](#없는-제목)\n<DocCard slug=\"models/backup\" />"),
  ];

  test("accepts published pages and existing anchors", () => {
    const valid = [
      page("ko/a", "## 모델 등록하기\n\n[b](/docs/b/#연결하기)\n<DocCard slug=\"b\" />"),
      page("ko/b", "## 연결하기\n\n[a](/docs/a/#모델-등록하기)\n[여기](#연결하기)"),
    ];
    expect(checkDocLinks(valid)).toEqual([]);
  });

  test("flags missing, planned, relative and slash-less targets", () => {
    expect(checkDocLinks(docs)).toEqual([
      "ko/models/cloud:11 /docs/models/nope/: no docs page",
      "ko/models/cloud:12 /docs/models/backup/: page is planned",
      "ko/models/custom:12 /docs/models/cloud/#없음: no heading #없음",
      "ko/basics/conversation:9 /docs/models/cloud: internal links are /docs/<slug>/",
      "ko/basics/conversation:10 ../models/cloud/: internal links are /docs/<slug>/",
      "ko/basics/conversation:11 #없는-제목: no heading #없는-제목",
      "ko/basics/conversation:12 /docs/models/backup/: page is planned",
    ]);
  });
});

describe("docs content", () => {
  const docs = contentDocs();

  test("every internal link in published pages resolves", () => {
    expect(docs.length).toBeGreaterThan(0);
    expect(checkDocLinks(docs)).toEqual([]);
  });

  test("Korean pages use 예약 작업, never 자동화", () => {
    expect(findTerms(docs.filter((doc) => doc.id.startsWith("ko/")), ["자동화"])).toEqual([]);
    expect(SECTIONS.map((section) => section.title.ko).filter((title) => title.includes("자동화"))).toEqual([]);
  });
});

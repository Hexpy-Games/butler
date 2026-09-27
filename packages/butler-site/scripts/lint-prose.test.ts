import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SKILL_PHRASES_REFERENCE, lintProse, loadBannedPhrases } from "./lint-prose";

const lint = (source: string) => lintProse("page.mdx", source);
const rules = (source: string) => lint(source).map((finding) => finding.rule);
const at = (source: string) => lint(source).map((finding) => [finding.rule, finding.line]);
const phraseIds = (source: string) =>
  lint(source).filter((finding) => finding.rule === "banned-phrase").map((finding) => finding.id);

describe("sentence-ending", () => {
  test("accepts 합니다체 prose", () => {
    expect(lint("설정을 엽니다. 모델을 고를 수 있습니다.\n\n다시 시작할까요 대신 다시 시작합니까?\n")).toEqual([]);
  });

  test("flags 해요체 and 해라체 sentences in body text with their line", () => {
    expect(at("첫 줄입니다.\n\n모델을 고르세요. 설정을 연다.\n")).toEqual([
      ["sentence-ending", 3],
      ["sentence-ending", 3],
    ]);
  });

  test("reports path:line in the message", () => {
    const [finding] = lintProse("ko/page.mdx", "\n\n모델을 고르세요.\n");
    expect(finding.path).toBe("ko/page.mdx");
    expect(finding.line).toBe(3);
    expect(finding.message).toContain("합니다");
  });

  test("flags a paragraph that ends in a fragment", () => {
    expect(rules("기본값: `30 minutes`\n")).toEqual(["sentence-ending"]);
  });

  test("allows headings, noun-phrase list items and table cells", () => {
    const source = [
      "## 창을 닫으면 Agent도 멈추나요?",
      "",
      "- macOS 12 이상",
      "- Apple Silicon Mac",
      "",
      "| 항목 | 설명 |",
      "| --- | --- |",
      "| **언어** | 앱 언어 |",
      "| **시간대** | 일정 맥락을 해석할 때 쓰는 시간대입니다. |",
      "",
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  test("allows a trailing example fragment after a sentence in a list item", () => {
    expect(lint("- 주소를 입력합니다. 예: `http://localhost:8080`\n- **닉네임** — Butler의 이름입니다. 예: Butler, 알프레드\n")).toEqual([]);
  });

  test("flags a period-terminated noun phrase inside a list item or table cell", () => {
    expect(rules("- **바로 넘어감** — 인증 오류, 권한 오류.\n")).toEqual(["sentence-ending"]);
    expect(rules("| **작업공간** | 작업공간 종류입니다. 예: **워크트리**, **로컬**. |\n")).toEqual(["sentence-ending"]);
  });

  test("ignores UI strings in bold or quotes, link text and trailing parentheticals", () => {
    const source = [
      "**대화의 작업 위치를 변경할까요?** 확인 창이 열립니다.",
      "",
      "먼저 모델을 등록합니다([클라우드 모델](/docs/models/cloud/), [Custom 모델](/docs/models/custom/)).",
      "",
      "\"다시 연결하고 있어요.\"가 표시되면 기다립니다.",
      "",
      "자세한 내용은 [문제 해결](/docs/troubleshooting/#로그-확인)을 참고합니다.",
      "",
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });
});

describe("masking", () => {
  test("ignores frontmatter, code fences, inline code, JSX tags and props, and URLs", () => {
    const source = [
      "---",
      'title: "다양한 설정"',
      "# 손쉽게 쓴다",
      "description: 손쉽게 씁니다",
      "---",
      "",
      "```bash",
      "echo 다양한 # 주석이다",
      "```",
      "",
      "`다음과 같다` 형식을 씁니다.",
      "",
      '<Notice tone="info" title="간편하게 쓰세요 — 🚀">',
      "  알림을 켭니다.",
      "</Notice>",
      "",
      '<DocCard href="https://example.com/효과적으로" description="강력한 도구다" />',
      "",
      "주소는 https://example.com/다양한/경로 형식입니다.",
      "",
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  test("keeps line numbers across multi-line JSX props", () => {
    const source = '<Tabs\n  label="운영체제"\n  items={[{ value: "a", label: "다양한" }]}\n>\n\n모델을 고르세요.\n';
    expect(at(source)).toEqual([["sentence-ending", 6]]);
  });

  test("treats inline components as words inside a sentence", () => {
    expect(lint('<span data-mod-key><Kbd keys={["⌘", "K"]} label="Command K" /></span>로 팔레트를 엽니다.\n')).toEqual([]);
  });
});

describe("banned-phrase", () => {
  test("each data-file example triggers its own phrase id and no other", () => {
    for (const phrase of loadBannedPhrases()) {
      expect({ id: phrase.id, found: phraseIds(phrase.example) }).toEqual({ id: phrase.id, found: [phrase.id] });
    }
  });

  test("flags phrases in headings and list items", () => {
    expect(phraseIds("## 다양한 설정\n\n- 자동화 목록을 엽니다.\n")).toEqual(["various", "automation"]);
  });

  test("ignores phrases inside bold UI labels, inline code, quotes and link URLs", () => {
    const source = "**다양한 모델**을 고릅니다. `것입니다`를 씁니다. \"간편하게\"가 표시됩니다. [문서](/docs/다양한/)를 참고합니다.\n";
    expect(lint(source)).toEqual([]);
  });

  test("names the phrase id in the finding", () => {
    const [finding] = lint("자주 보는 오류는 다음과 같습니다.\n");
    expect(finding.id).toBe("as-follows");
    expect(finding.message).toContain("as-follows");
  });
});

describe("em-dash", () => {
  test("allows one term-definition dash per list item", () => {
    const source = [
      "- **전송** — 메시지를 보냅니다.",
      "- `name` — 스킬 이름입니다.",
      '- <Kbd keys={["Enter"]} /> — 항목을 엽니다.',
      "- 컨텍스트 사용량 — 원 모양 표시에 마우스를 올립니다.",
      "",
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });

  test("flags dashes in paragraphs, tables, second dashes and dashes after a sentence", () => {
    expect(rules("설정을 엽니다 — 그리고 모델을 고릅니다.\n")).toEqual(["em-dash"]);
    expect(rules("- **전송** — 보냅니다 — 바로 보냅니다.\n")).toEqual(["em-dash"]);
    expect(rules("- 메시지를 보냅니다. — 바로 보냅니다.\n")).toEqual(["em-dash"]);
    expect(rules("| 항목 | 값입니다 — 설명입니다. |\n")).toEqual(["em-dash"]);
    expect(rules("## 설치 — 처음 열기\n")).toEqual(["em-dash"]);
  });
});

describe("emoji", () => {
  test("flags emoji in prose", () => {
    expect(rules("🚀 설정을 엽니다.\n")).toEqual(["emoji"]);
    expect(rules("⚠️ 키를 확인합니다.\n")).toEqual(["emoji"]);
    expect(rules("- **완료** ✅\n")).toEqual(["emoji"]);
  });

  test("does not treat symbols, arrows or keys as emoji", () => {
    const source = '<Kbd keys={["⌘", "K"]} />를 누릅니다. **설정 → 일반**을 엽니다. 메뉴(⋯)를 엽니다. `a` → `b`로 바뀝니다.\n';
    expect(lint(source)).toEqual([]);
  });

  test("ignores emoji inside code", () => {
    expect(lint("`🚀`가 표시됩니다.\n")).toEqual([]);
  });
});

describe("bold-flanking", () => {
  test("flags bold that Markdown cannot close: punctuation before ** and a letter right after", () => {
    expect(at("오류가 나면\n**준비하지 못했습니다.**가 표시됩니다.\n")).toEqual([["bold-flanking", 2]]);
    expect(rules("값이**(선택)** 표시됩니다.\n")).toEqual(["bold-flanking"]);
  });

  test("accepts bold followed by a space, punctuation or nothing", () => {
    const source = "**준비하지 못했습니다.** 메시지가 표시됩니다. (**모델 검색...**)을 엽니다. [**아카이브**](/docs/settings/#아카이브)를 엽니다.\n";
    expect(lint(source)).toEqual([]);
  });
});

describe("mixed-list", () => {
  test("flags a list that mixes sentence items and noun-phrase items", () => {
    const source = "- 이벤트 종류 — **대화 기억 정리**, **사용자 정보 분석**\n- **새로고침**으로 다시 불러옵니다.\n";
    expect(at(source)).toEqual([["mixed-list", 2]]);
  });

  test("accepts lists that keep one style", () => {
    expect(lint("- 사이드바를 엽니다.\n- 설정을 누릅니다.\n\n1. `--data PATH` 옵션\n2. `BUTLER_DATA` 환경 변수\n3. `~/.butler`\n")).toEqual([]);
  });

  test("treats a label-only parent of a nested list as neutral", () => {
    const source = "- **진행 상황** — 단계를 보여 줍니다.\n- **브랜치 상세**\n  - **게이트웨이** — 처리 상태입니다.\n  - **Git 브랜치** — 현재 브랜치입니다.\n";
    expect(lint(source)).toEqual([]);
  });

  test("counts a label-only item without children as a noun phrase", () => {
    expect(at("- **이름 변경** — 이름을 바꿉니다.\n- **즐겨찾기에 추가** / **즐겨찾기 해제**\n")).toEqual([["mixed-list", 2]]);
  });

  test("a JSX tag line ends a list, so an indented Notice body is not an item", () => {
    expect(lint("- macOS 12 이상\n- Apple Silicon Mac\n\n<Notice>\n  Agent는 따로 설치하지 않습니다.\n</Notice>\n")).toEqual([]);
  });

  test("keeps nested lists and different marker types separate", () => {
    const steps = "<Steps>\n  1. 행을 끕니다.\n     - 목록 끝\n     - 그룹 위\n  2. 원하는 위치에 놓습니다.\n</Steps>\n";
    expect(lint(steps)).toEqual([]);
    expect(lint("1. 이름을 읽습니다.\n2. 본문을 읽습니다.\n\n- `name`\n- `description`\n")).toEqual([]);
  });
});

describe("escape hatch", () => {
  test("disable-next-line with a reason suppresses the named rule on the next line", () => {
    const source = "{/* prose-lint-disable-next-line sentence-ending -- quotes the app's safety notice verbatim */}\n모델을 고르세요.\n";
    expect(lint(source)).toEqual([]);
  });

  test("disable-line suppresses a finding on its own line", () => {
    const source = "- 한 번 더 확인하세요. {/* prose-lint-disable-line sentence-ending -- verbatim app notice */}\n";
    expect(lint(source)).toEqual([]);
  });

  test("a phrase id can be disabled on its own", () => {
    const source = "{/* prose-lint-disable-next-line banned-phrase/as-follows -- quoted from the CLI help */}\n오류는 다음과 같습니다.\n";
    expect(lint(source)).toEqual([]);
  });

  test("a directive without a reason is a finding and does not suppress", () => {
    expect(at("{/* prose-lint-disable-next-line sentence-ending */}\n모델을 고르세요.\n")).toEqual([
      ["disable-syntax", 1],
      ["sentence-ending", 2],
    ]);
  });

  test("an unknown rule id is a finding", () => {
    expect(rules("{/* prose-lint-disable-next-line no-such-rule -- because */}\n설정을 엽니다.\n")).toEqual(["disable-syntax"]);
  });

  test("an unused directive is a finding", () => {
    expect(at("{/* prose-lint-disable-next-line emoji -- the heading had an icon */}\n설정을 엽니다.\n")).toEqual([["unused-disable", 1]]);
  });
});

describe("skill reference", () => {
  test("lists exactly the phrase ids in the lint data file", () => {
    const reference = readFileSync(SKILL_PHRASES_REFERENCE, "utf8");
    const listed = [...reference.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gmu)].map((match) => match[1]);
    expect(listed.sort()).toEqual(loadBannedPhrases().map((phrase) => phrase.id).sort());
  });
});

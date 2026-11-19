import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ShowcaseRenderContext } from "../../showcase";
import { sampleFaviconSrc } from "../../components/InlineReference/sampleFavicons";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownLink } from "./MarkdownLink";
import { MarkdownTable } from "./MarkdownParts";

const REPLY = {
  "en-US": `I checked the release and the docs.

- The fix landed in [PR #539: release republish](https://github.com/example-org/notes/pull/539); the tracking issue is https://github.com/example-org/notes/issues/512.
- Background: the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) and [rel=noopener on MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener).
- The raw report: https://reports.design-system.platform.example.com/teams/butler/inline-reference/2026/10/very-long-report-name?view=full&tab=links#section-4

| Source | Link |
| --- | --- |
| Guide | [First run](https://docs.example.com/guide/first-run/) |
| Mirror | https://mirror.example.org/butler |

### Notes from [the changelog](https://docs.example.com/changelog)

Questions go to [support@example.com](mailto:support@example.com); see also the [notes below](#notes).`,
  "ko-KR": `릴리스와 문서를 확인했어요.

- 수정은 [PR #539: 릴리스 재게시](https://github.com/example-org/notes/pull/539)에 들어갔고, 추적 이슈는 https://github.com/example-org/notes/issues/512 입니다.
- 참고 자료: [Electron 보안 체크리스트](https://www.electronjs.org/docs/latest/tutorial/security)와 [MDN의 rel=noopener](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener).
- 원본 보고서: https://reports.design-system.platform.example.com/teams/butler/inline-reference/2026/10/very-long-report-name?view=full&tab=links#section-4

| 출처 | 링크 |
| --- | --- |
| 안내서 | [처음 실행](https://docs.example.com/guide/first-run/) |
| 미러 | https://mirror.example.org/butler |

### [변경 기록](https://docs.example.com/changelog) 메모

문의는 [support@example.com](mailto:support@example.com)로 보내고, [아래 메모](#notes)도 함께 보세요.`,
} as const;

const COMPONENTS = { a: MarkdownLink, table: MarkdownTable };

/** An assistant reply with titled links, bare URLs, a long URL, a table, a heading link and mailto. */
export function MarkdownLinkSample({ locale }: ShowcaseRenderContext) {
  return (
    <MarkdownContent faviconSrc={sampleFaviconSrc}>
      <ReactMarkdown components={COMPONENTS} remarkPlugins={[remarkGfm]}>{REPLY[locale]}</ReactMarkdown>
    </MarkdownContent>
  );
}

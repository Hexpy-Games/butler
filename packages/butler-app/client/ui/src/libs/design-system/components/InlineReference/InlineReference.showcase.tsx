import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { FileText, MessageSquare } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { InlineReference } from "./InlineReference";
import { SAMPLE_FAVICONS } from "./sampleFavicons";

export const meta: ShowcaseMeta = {
  title: "InlineReference",
  category: "Data display",
  tags: ["reference", "mention", "inline", "link", "external", "url", "favicon"],
  status: "stable",
};

const copy = {
  "en-US": {
    before: "Continue from", conversation: "Insurance coverage comparison", after: "and check",
    document: "Q3 planning notes", end: ".",
    gone: "An earlier reference to", removed: "Deleted draft", tail: "stays readable after it is removed.",
    extBefore: "The fix is in", pr: "PR #539: release republish", extMid: ", tracked at", extAnd: "; see the", guide: "first-run guide", extEnd: ".",
    longBefore: "Background reading:", longTitle: "Hardening a desktop app that opens links from untrusted model output", longMid: "and the raw report at",
    heading: "Notes from", changelog: "the changelog",
    fallbackBefore: "No favicon yet, or none at all:", broken: "MDN on rel=noopener", fallbackEnd: "keep the globe.",
  },
  "ko-KR": {
    before: "이전", conversation: "보험 보장 비교", after: "내용과",
    document: "3분기 계획 메모", end: "를 참고해 주세요.",
    gone: "삭제된", removed: "초안 문서", tail: "도 기록에는 흐리게 남습니다.",
    extBefore: "수정은", pr: "PR #539: 릴리스 재게시", extMid: "에 들어갔고, 추적은", extAnd: "에서 합니다.", guide: "처음 실행 안내서", extEnd: "도 참고하세요.",
    longBefore: "참고 자료:", longTitle: "신뢰할 수 없는 모델 출력의 링크를 여는 데스크톱 앱 보안 강화하기", longMid: "그리고 원본 보고서",
    heading: "메모 출처:", changelog: "변경 기록",
    fallbackBefore: "파비콘이 아직 없거나 아예 없으면", broken: "MDN의 rel=noopener", fallbackEnd: "처럼 지구본이 남습니다.",
  },
} as const;

const PR = "https://github.com/example-org/notes/pull/539";
const ISSUE = "https://github.com/example-org/notes/issues/512";
const GUIDE = "https://docs.example.com/guide/first-run/";
const LONG = "https://reports.design-system.platform.example.com/teams/butler/inline-reference/2026/10/very-long-report-name?view=full#section-4";
const MDN = "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener";

function ExternalSentence({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  return (
    <Typo.Body as="p">
      {text.extBefore} <InlineReference kind="external" href={PR} iconSrc={SAMPLE_FAVICONS["github.com"]}>{text.pr}</InlineReference>
      {text.extMid} <InlineReference kind="external" href={ISSUE} iconSrc={SAMPLE_FAVICONS["github.com"]} />{text.extAnd}{" "}
      <InlineReference kind="external" href={GUIDE} iconSrc={SAMPLE_FAVICONS["docs.example.com"]}>{text.guide}</InlineReference>{text.extEnd}
    </Typo.Body>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "In running text",
    states: ["default", "hover"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <Typo.Body as="p">
          {text.before} <InlineReference icon={<MessageSquare />} onClick={() => undefined}>{text.conversation}</InlineReference>{" "}
          {text.after} <InlineReference icon={<FileText />} onClick={() => undefined}>{text.document}</InlineReference>{text.end}
        </Typo.Body>
      );
    },
  },
  { name: "External links", states: ["default", "hover", "focus-visible"], render: (context) => <ExternalSentence {...context} /> },
  {
    name: "Long titles and URLs wrap",
    widths: ["320", "375", "app"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <Stack gap="sm">
          <Typo.H3>{text.heading} <InlineReference kind="external" href={GUIDE} iconSrc={SAMPLE_FAVICONS["docs.example.com"]}>{text.changelog}</InlineReference></Typo.H3>
          <Typo.Body as="p">
            {text.longBefore} <InlineReference kind="external" href={MDN} iconSrc={SAMPLE_FAVICONS["www.electronjs.org"]}>{text.longTitle}</InlineReference>{" "}
            {text.longMid} <InlineReference kind="external" href={LONG} />.
          </Typo.Body>
        </Stack>
      );
    },
  },
  {
    name: "Favicon fallback",
    states: ["loading"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <Typo.Body as="p">
          {text.fallbackBefore} <InlineReference kind="external" href={MDN} iconSrc={SAMPLE_FAVICONS["developer.mozilla.org"]}>{text.broken}</InlineReference>{" "}
          <InlineReference kind="external" href="https://mirror.example.org/butler" /> {text.fallbackEnd}
        </Typo.Body>
      );
    },
  },
  {
    name: "Unavailable",
    states: ["disabled"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <Stack gap="sm">
          <Typo.Body as="p">
            {text.gone} <InlineReference icon={<FileText />} unavailable>{text.removed}</InlineReference> {text.tail}
          </Typo.Body>
        </Stack>
      );
    },
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible"],
  variants: ["mention", "external", "external without favicon"],
  render: ({ locale, variant }) => {
    const text = copy[locale];
    if (variant === "mention") return <Typo.Body><InlineReference icon={<FileText />} onClick={() => undefined}>{text.document}</InlineReference></Typo.Body>;
    return (
      <Typo.Body>
        <InlineReference kind="external" href={PR} iconSrc={variant === "external" ? SAMPLE_FAVICONS["github.com"] : undefined}>{text.pr}</InlineReference>
      </Typo.Body>
    );
  },
};

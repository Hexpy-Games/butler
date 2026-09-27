import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { FileText, MessageSquare } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { InlineReference } from "./InlineReference";

export const meta: ShowcaseMeta = {
  title: "InlineReference",
  category: "Data display",
  tags: ["reference", "mention", "inline", "link"],
  status: "stable",
};

const copy = {
  "en-US": {
    before: "Continue from", conversation: "Insurance coverage comparison", after: "and check",
    document: "Q3 planning notes", end: ".",
    gone: "An earlier reference to", removed: "Deleted draft", tail: "stays readable after it is removed.",
  },
  "ko-KR": {
    before: "이전", conversation: "보험 보장 비교", after: "내용과",
    document: "3분기 계획 메모", end: "를 참고해 주세요.",
    gone: "삭제된", removed: "초안 문서", tail: "도 기록에는 흐리게 남습니다.",
  },
} as const;

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

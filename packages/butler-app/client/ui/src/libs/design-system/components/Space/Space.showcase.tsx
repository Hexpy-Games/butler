import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Tag } from "../Tag";
import { Typo } from "../Typo";
import { Space } from "./Space";

export const meta: ShowcaseMeta = {
  title: "Space",
  category: "Layout",
  tags: ["layout", "spacing", "gap"],
  status: "stable",
};

const labels = {
  "en-US": { answer: "I updated the settings pages and reran the layout smoke.", artifacts: "Artifacts", files: "Changed files" },
  "ko-KR": { answer: "설정 페이지를 고치고 레이아웃 스모크를 다시 실행했습니다.", artifacts: "산출물", files: "변경된 파일" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const SIZES = ["none", "xs", "sm", "md", "lg", "xl", "2xl"] as const;

export const stories: ShowcaseStory[] = [
  {
    // MessageArtifacts / MessageChangedFiles: a md gap between the answer and its attachments.
    name: "Between a message and its attachments",
    render: (context) => (
      <div>
        <Typo.Body>{text(context).answer}</Typo.Body>
        <Space size="md" />
        <Typo.SectionTitle>{text(context).artifacts}</Typo.SectionTitle>
        <Space size="xs" />
        <Typo.Caption>release-notes.md · design-review.png</Typo.Caption>
      </div>
    ),
  },
  {
    name: "Vertical scale",
    render: () => (
      <div>
        {SIZES.map((size) => (
          <div key={size}>
            <Tag>{size}</Tag>
            <Space size={size} />
          </div>
        ))}
      </div>
    ),
  },
  {
    name: "Horizontal",
    render: (context) => (
      <Stack align="row" cross="center" gap="none">
        <Tag>{text(context).artifacts}</Tag>
        <Space direction="horizontal" size="lg" />
        <Tag>{text(context).files}</Tag>
      </Stack>
    ),
  },
];

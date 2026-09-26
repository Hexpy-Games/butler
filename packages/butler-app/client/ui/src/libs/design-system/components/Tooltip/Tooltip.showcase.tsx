import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ComposerControl } from "../../blocks/ComposerControl";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { AiChip, PanelRight } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Tooltip } from "./Tooltip";

export const meta: ShowcaseMeta = {
  title: "Tooltip",
  category: "Overlay",
  tags: ["help", "accessibility", "glass", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    hint: "Hover for 650ms or focus with the keyboard. Tooltips name controls; they never hold actions.",
    model: "Model", modelHint: "Switch models after this response finishes", panel: "Show right panel",
    shortcut: "Copy link", long: "Opens the project dashboard in the right panel and keeps the conversation in place",
  },
  "ko-KR": {
    hint: "650ms 동안 올려 두거나 키보드로 포커스하세요. 툴팁은 컨트롤 이름만 보여 주며 동작을 담지 않습니다.",
    model: "모델", modelHint: "이 응답이 끝난 뒤 모델을 바꿀 수 있습니다", panel: "오른쪽 패널 보기",
    shortcut: "링크 복사", long: "대화를 그대로 둔 채 오른쪽 패널에서 프로젝트 대시보드를 엽니다",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Icon button label",
    states: ["hover", "focus-visible"],
    render: (context) => (
      <Stack gap="sm">
        {/* IconButton wraps itself in Tooltip with its label. */}
        <IconButton label={text(context).panel}><PanelRight size="md" /></IconButton>
        <Typo.Caption tone="secondary">{text(context).hint}</Typo.Caption>
      </Stack>
    ),
  },
  {
    // ComposerModelStatusButton: a disabled control explains itself on hover.
    name: "Why a control is unavailable",
    render: (context) => (
      <Tooltip label={text(context).modelHint}>
        <ComposerControl aria-disabled="true" aria-label={`${text(context).model}. ${text(context).modelHint}`}
          icon={<AiChip size="sm" />} label={text(context).model} />
      </Tooltip>
    ),
  },
  {
    name: "Long label wraps inside the viewport",
    render: (context) => (
      <Tooltip label={text(context).long}>
        <Button variant="outline" size="sm" text={text(context).shortcut} />
      </Tooltip>
    ),
  },
];

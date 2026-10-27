import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Clickable } from "../../components/Clickable";
import { Clock3, FileText } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ListRow } from "./ListRow";

export const meta: ShowcaseMeta = {
  title: "ListRow",
  category: "Navigation",
  tags: ["row", "list", "data", "two-region"],
  status: "stable",
};

const labels = {
  "en-US": {
    model: "Qwen2.5 Coder 14B", modelRef: "ollama/qwen2.5-coder:14b", modelMeta: "32K tokens · medium reasoning",
    automation: "Nightly release notes", target: "butler · main", every: "Every day 07:00", state: "active / Every day 07:00",
    artifact: "A long artifact name that truncates when the inspector is narrow.md", edit: "Edit", remove: "Remove",
    schedule: "Daily eight", scheduleMeta: "Active · Every day 08:00 · Next Tue 08:00 · Ask before acting",
    longTitle: "Weekly dependency audit for every workspace repository",
  },
  "ko-KR": {
    model: "Qwen2.5 Coder 14B", modelRef: "ollama/qwen2.5-coder:14b", modelMeta: "32K 토큰 · 보통 추론",
    automation: "야간 릴리스 노트", target: "butler · main", every: "매일 07:00", state: "활성 / 매일 07:00",
    artifact: "인스펙터가 좁을 때 말줄임되는 아주 긴 산출물 이름.md", edit: "편집", remove: "삭제",
    schedule: "매일 여덟 시", scheduleMeta: "활성 · 매일 08:00 · 다음 실행 화 08:00 · 실행 전 확인",
    longTitle: "모든 작업 공간 저장소의 주간 의존성 점검",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Title, description and meta",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="sm">
        <ListRow icon={<Clock3 size="md" />} title={text(context).automation} meta={text(context).every} />
        <ListRow title={text(context).automation} description={text(context).target} meta={text(context).state} />
        <ListRow icon={<FileText size="md" />} title={text(context).artifact} />
      </Stack>
    ),
  },
  {
    // A meta longer than half the row moves under the title and wraps there;
    // the title keeps its line and truncates. Compare the 320 and app widths.
    name: "Long meta in a narrow row",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="sm">
        <ListRow icon={<Clock3 size="md" />} title={text(context).schedule} description={text(context).target} meta={text(context).scheduleMeta} />
        <ListRow icon={<Clock3 size="md" />} title={text(context).longTitle} description={text(context).target} meta={text(context).scheduleMeta} />
        <ListRow icon={<Clock3 size="md" />} title={text(context).longTitle} meta={text(context).every} />
      </Stack>
    ),
  },
  {
    // LocalModelRow: a static row next to its own actions.
    name: "With trailing actions (local model)",
    render: (context) => (
      <Stack align="row" cross="center" gap="sm">
        <Stack.Item grow minWidth="0">
          <ListRow title={text(context).model} description={text(context).modelRef} meta={text(context).modelMeta} />
        </Stack.Item>
        <ButtonContainer size="icon-sm">
          <Button size="sm" variant="borderless" text={text(context).edit} />
          <Button size="sm" variant="borderless" text={text(context).remove} />
        </ButtonContainer>
      </Stack>
    ),
  },
  {
    name: "Inside a Clickable (selectable list)",
    render: (context) => (
      <Clickable aria-current="page" onClick={() => undefined} stretch>
        <ListRow title={text(context).automation} description={text(context).target} meta={text(context).state} />
      </Clickable>
    ),
  },
];

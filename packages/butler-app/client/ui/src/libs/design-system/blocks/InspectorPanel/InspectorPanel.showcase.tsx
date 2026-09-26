import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Activity, Circle, FileText } from "../../components/Icons";
import { EmptyLine } from "../EmptyLine";
import { KeyValueRow } from "../KeyValueRow";
import { ListRow } from "../ListRow";
import { InspectorPanel } from "./InspectorPanel";

export const meta: ShowcaseMeta = {
  title: "InspectorPanel",
  category: "Inspector",
  tags: ["inspector", "panel", "summary"],
  status: "stable",
};

const labels = {
  "en-US": {
    branch: "Branch details", gateway: "Gateway", ready: "Ready", branchLabel: "Git branch", skills: "Skills",
    noSkills: "No skills used in this conversation.", workers: "Workers", context: "Context", contextMeta: "Last updated just now",
    tokens: "Tokens", files: "Files", refresh: "Refresh",
  },
  "ko-KR": {
    branch: "브랜치 정보", gateway: "게이트웨이", ready: "준비됨", branchLabel: "Git 브랜치", skills: "스킬",
    noSkills: "이 대화에서 사용한 스킬이 없습니다.", workers: "작업자", context: "컨텍스트", contextMeta: "방금 갱신됨",
    tokens: "토큰", files: "파일", refresh: "새로고침",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Summary: branch details",
    render: (context) => (
      <InspectorPanel title={text(context).branch}>
        <KeyValueRow label={text(context).gateway} value={text(context).ready} />
        <KeyValueRow label={text(context).branchLabel} value="main" />
      </InspectorPanel>
    ),
  },
  {
    name: "Icon, description and action",
    render: (context) => (
      <InspectorPanel title={text(context).context} description={text(context).contextMeta} icon={<Activity size="md" />}
        action={<Button size="xs" variant="borderless" text={text(context).refresh} />}>
        <KeyValueRow label={text(context).tokens} value="18,240" meta="62%" />
        <KeyValueRow label={text(context).files} value="8" />
      </InspectorPanel>
    ),
  },
  {
    name: "Skills list and empty state",
    render: (context) => (
      <InspectorPanel title={text(context).skills}>
        <ListRow icon={<FileText size="md" />} title="butler-design-system" />
        <EmptyLine icon={<Circle size="md" />} message={text(context).noSkills} />
      </InspectorPanel>
    ),
  },
];

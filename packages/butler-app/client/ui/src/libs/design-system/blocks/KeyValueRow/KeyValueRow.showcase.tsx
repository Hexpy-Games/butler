import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { KeyValueRow } from "./KeyValueRow";

export const meta: ShowcaseMeta = {
  title: "KeyValueRow",
  category: "Inspector",
  tags: ["inspector", "key-value", "context", "legend"],
  status: "stable",
};

const labels = {
  "en-US": {
    gateway: "Gateway", ready: "Ready", branch: "Git branch", workspace: "Workspace", local: "Local", changes: "Changes", clean: "Clean",
    categories: [
      { label: "System prompt", description: "Instructions, tools and skills", value: "12.4K", meta: "18%", color: "var(--context-chart-1)" },
      { label: "Conversation", description: "Messages and tool results in this turn and the ones before it", value: "38.1K", meta: "54%", color: "var(--context-chart-2)" },
      { label: "Files", description: "Pinned project documents", value: "6.2K", meta: "9%", color: "var(--context-chart-3)" },
    ],
    provider: "Provider", runtime: "Runtime", secrets: "Secrets", redacted: "Redacted",
  },
  "ko-KR": {
    gateway: "게이트웨이", ready: "준비됨", branch: "Git 브랜치", workspace: "작업 공간", local: "로컬", changes: "변경 사항", clean: "깨끗함",
    categories: [
      { label: "시스템 프롬프트", description: "지침, 도구, 스킬", value: "12.4K", meta: "18%", color: "var(--context-chart-1)" },
      { label: "대화", description: "이번 턴과 이전 턴의 메시지와 도구 결과", value: "38.1K", meta: "54%", color: "var(--context-chart-2)" },
      { label: "파일", description: "고정한 프로젝트 문서", value: "6.2K", meta: "9%", color: "var(--context-chart-3)" },
    ],
    provider: "제공자", runtime: "런타임", secrets: "비밀 값", redacted: "가려짐",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // SummaryPanel: branch details.
    name: "Branch details",
    render: (context) => {
      const copy = text(context);
      return (
        <Stack gap="xs">
          <KeyValueRow label={copy.gateway} value={copy.ready} />
          <KeyValueRow label={copy.branch} value="ui/ds-viewer-complete" />
          <KeyValueRow label={copy.workspace} value={copy.local} />
          <KeyValueRow label={copy.changes} value={copy.clean} />
        </Stack>
      );
    },
  },
  {
    // ContextCategoryRow: the swatch binds to the label line, not the row center.
    name: "Context legend with swatches",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="xs">
        {text(context).categories.map((category) => (
          <KeyValueRow key={category.label} label={category.label} description={category.description} value={category.value}
            meta={category.meta} detailAlign="start" swatchColor={category.color} valueTextSize="caption" />
        ))}
      </Stack>
    ),
  },
  {
    // DeveloperLogMetadataPanel: two-column grid of facts.
    name: "Metadata grid",
    render: (context) => (
      <Grid columns="2" gap="sm">
        <KeyValueRow label={text(context).provider} value="openai" />
        <KeyValueRow label={text(context).runtime} value="responses" />
        <KeyValueRow label={text(context).secrets} value={text(context).redacted} detailLayout="stack" />
      </Grid>
    ),
  },
];

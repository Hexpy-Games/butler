import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SurfacePanel } from "./SurfacePanel";

export const meta: ShowcaseMeta = {
  title: "SurfacePanel",
  category: "Shell",
  tags: ["surface", "panel", "settings", "elevation"],
  status: "stable",
};

const labels = {
  "en-US": {
    usage: "API provider usage", usageMeta: "OpenAI · this month", tokens: "1.2M tokens",
    archived: "Release checklist review", archivedMeta: "Conversation · 3 days ago", restore: "Restore",
    elevation: "elevation",
  },
  "ko-KR": {
    usage: "API 제공자 사용량", usageMeta: "OpenAI · 이번 달", tokens: "120만 토큰",
    archived: "릴리스 체크리스트 검토", archivedMeta: "대화 · 3일 전", restore: "복원",
    elevation: "높이",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // UsageProviderPanel: flat (elevation none) settings rows.
    name: "Settings row panel",
    widths: ["375", "app"],
    render: (context) => (
      <SurfacePanel elevation="none">
        <Stack align="row" justify="between" cross="start" gap="md" wrap>
          <Stack gap="xs" grow basis="md" minWidth="0">
            <Typo.Body as="div">{text(context).usage}</Typo.Body>
            <Typo.Caption>{text(context).usageMeta}</Typo.Caption>
          </Stack>
          <Typo.MetricValue>{text(context).tokens}</Typo.MetricValue>
        </Stack>
      </SurfacePanel>
    ),
  },
  {
    // ArchiveItemRow
    name: "Archive item",
    render: (context) => (
      <SurfacePanel elevation="none">
        <Stack align="row" cross="center" gap="md" justify="between" wrap>
          <Stack gap="xs">
            <Typo.Body as="div">{text(context).archived}</Typo.Body>
            <Typo.Caption>{text(context).archivedMeta}</Typo.Caption>
          </Stack>
          <Button size="sm" variant="outline" text={text(context).restore} />
        </Stack>
      </SurfacePanel>
    ),
  },
  {
    name: "Elevations",
    render: (context) => (
      <Stack gap="md">
        {(["none", "low", "medium", "high"] as const).map((elevation) => (
          <SurfacePanel elevation={elevation} key={elevation}>
            <Typo.Caption>{`${text(context).elevation}: ${elevation}`}</Typo.Caption>
          </SurfacePanel>
        ))}
      </Stack>
    ),
  },
];

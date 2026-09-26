import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { FileText, Folder, Rocket } from "../../components/Icons";
import { ResourceTile } from "./ResourceTile";

export const meta: ShowcaseMeta = {
  title: "ResourceTile",
  category: "Dashboard & Metrics",
  tags: ["tile", "resource", "grid", "card"],
  status: "beta",
};

const labels = {
  "en-US": {
    project: "butler", projectMeta: "12 conversations", projectHint: "Desktop app and agent gateway",
    spec: "Design-system spec", specMeta: "Updated today", release: "Release 0.0.22", releaseMeta: "3 checks left",
  },
  "ko-KR": {
    project: "butler", projectMeta: "대화 12개", projectHint: "데스크톱 앱과 에이전트 게이트웨이",
    spec: "디자인 시스템 명세", specMeta: "오늘 수정", release: "릴리스 0.0.22", releaseMeta: "남은 점검 3개",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Tile grid",
    widths: ["375", "app", "wide"],
    render: (context) => {
      const copy = text(context);
      return (
        <Grid columns="auto-fit" gap="sm">
          <ResourceTile icon={<Folder size="xl" />} title={copy.project} meta={copy.projectMeta} description={copy.projectHint} />
          <ResourceTile icon={<FileText size="xl" />} title={copy.spec} meta={copy.specMeta} />
          <ResourceTile icon={<Rocket size="xl" />} title={copy.release} meta={copy.releaseMeta} />
        </Grid>
      );
    },
  },
];

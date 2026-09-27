import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText, Save } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { DocumentTile } from "./DocumentTile";

export const meta: ShowcaseMeta = {
  title: "DocumentTile",
  category: "Documents & Artifacts",
  tags: ["document", "tile", "artifact", "dashboard", "plan"],
  status: "stable",
};

const labels = {
  "en-US": {
    open: "Open", save: "Save", document: "document / 7.6 KB", ago: "2d ago", plan: "Plan", review: "In review",
    planTitle: "OAuth connection and model presets rollout plan", spec: "Model presets and OAuth",
  },
  "ko-KR": {
    open: "열기", save: "저장", document: "문서 / 7.6 KB", ago: "2일 전", plan: "계획", review: "검토 중",
    planTitle: "OAuth 연결과 모델 프리셋 배포 계획", spec: "모델 프리셋과 OAuth",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // ArtifactsPanel (inspector): the whole tile opens; save is an icon action.
    name: "Inspector artifact (tile opens)",
    widths: ["320", "375", "430"],
    render: (context) => {
      const title = "butler-dedicated-client-composer.md";
      return (
        <DocumentTile icon={<FileText size="md" />} title={title} description={text(context).document} meta={text(context).ago}
          clickTarget="tile" ariaLabel={`${text(context).open}: ${title}`} onOpen={() => undefined}
          actions={[{ id: "save", label: text(context).save, icon: <Save size="sm" />, onClick: () => undefined }]} />
      );
    },
  },
  {
    // ProjectDocumentsPanel: badge + status, explicit Open action.
    name: "Dashboard plan and spec (Open action)",
    render: (context) => (
      <Stack gap="xs">
        <DocumentTile badge={text(context).plan} icon={<FileText size="md" />} title={text(context).planTitle} meta={text(context).review}
          actionLabel={text(context).open} onOpen={() => undefined} />
        <DocumentTile icon={<FileText size="md" />} title={text(context).spec} meta="specs/model-presets-and-oauth.md"
          actionLabel={text(context).open} onOpen={() => undefined} />
      </Stack>
    ),
  },
];

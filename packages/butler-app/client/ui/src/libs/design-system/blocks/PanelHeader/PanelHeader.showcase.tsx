import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ArrowLeft, Plus } from "../../components/Icons";
import { PanelHeader } from "./PanelHeader";

export const meta: ShowcaseMeta = {
  title: "PanelHeader",
  category: "Shell",
  tags: ["panel", "header", "inspector", "artifact"],
  status: "stable",
};

const labels = {
  "en-US": {
    artifact: "release-notes.md", artifactMeta: "Markdown · 4.2 KB · updated 3 minutes ago", back: "All artifacts",
    context: "Context usage", contextMeta: "What fills the model's context window", add: "Add",
  },
  "ko-KR": {
    artifact: "release-notes.md", artifactMeta: "마크다운 · 4.2 KB · 3분 전 수정", back: "모든 산출물",
    context: "컨텍스트 사용량", contextMeta: "모델 컨텍스트 창을 채우는 항목", add: "추가",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // ArtifactViewer: title, meta description and a back action.
    name: "Artifact viewer header",
    widths: ["320", "375", "app"],
    render: (context) => (
      <PanelHeader title={text(context).artifact} description={text(context).artifactMeta}
        actions={<Button iconStart={<ArrowLeft size="sm" />} size="xs" text={text(context).back} variant="borderless" />} />
    ),
  },
  {
    name: "Title and description",
    render: (context) => (
      <PanelHeader title={text(context).context} description={text(context).contextMeta}
        actions={<Button iconStart={<Plus size="md" />} text={text(context).add} variant="outline" size="sm" />} />
    ),
  },
  { name: "Title only", render: (context) => <PanelHeader title={text(context).context} /> },
];

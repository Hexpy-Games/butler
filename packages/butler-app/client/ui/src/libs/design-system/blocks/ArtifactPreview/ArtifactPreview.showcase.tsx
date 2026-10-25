import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Typo } from "../../components/Typo";
import { ShellFrameDemo } from "../AdaptiveShell/fixtures/ShellFrameDemo";
import { ArtifactPreview, ArtifactPreviewFrame, ArtifactPreviewImage, ArtifactPreviewPre } from "./index";

export const meta: ShowcaseMeta = {
  title: "ArtifactPreview",
  category: "Documents & Artifacts",
  tags: ["artifact", "preview", "image", "pdf", "text"],
  status: "stable",
};

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' viewBox='0 0 320 180'%3E%3Crect width='320' height='180' fill='%23e9eaec'/%3E%3Cpath d='m40 140 70-70 50 45 35-30 85 55H40Z' fill='%2371767d'/%3E%3Ccircle cx='250' cy='50' r='18' fill='%239a9da2'/%3E%3C/svg%3E";
const PAGE = "data:text/html,%3Cbody style='font:14px system-ui;padding:16px'%3E%3Ch3%3EQuarterly report%3C/h3%3E%3Cp%3EEmbedded preview frame.%3C/p%3E%3C/body%3E";

const PART = "data:text/html,%3Cbody style='margin:0;font:14px system-ui'%3E%3Cdiv style='width:240px;height:96px;box-sizing:border-box;padding:12px;border:1px solid %23d8dce6;border-radius:12px;background:white'%3E%3Cb%3EClipped card%3C/b%3E%3Cp style='margin:6px 0 0'%3EShown at its own size.%3C/p%3E%3C/div%3E%3C/body%3E";

const labels = {
  "en-US": { text: "# Release notes\n\n- Token pages generated from tokens.css\n- States matrix on item pages\n- Motion page with replay", image: "Settings at 375px", frame: "Quarterly report", part: "Clipped card", loading: "Loading the artifact…", failed: "Could not load this artifact." },
  "ko-KR": { text: "# 릴리스 노트\n\n- tokens.css에서 만든 토큰 페이지\n- 항목 페이지의 상태 매트릭스\n- 다시 재생되는 모션 페이지", image: "375px 설정 화면", frame: "분기 보고서", part: "스크랩한 카드", loading: "산출물을 불러오는 중…", failed: "이 산출물을 불러오지 못했습니다." },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

// ArtifactViewer renders exactly one of these inside ArtifactPreview, by artifact mode and load state.
export const stories: ShowcaseStory[] = [
  { name: "Text", render: (context) => <ArtifactPreview><ArtifactPreviewPre>{text(context).text}</ArtifactPreviewPre></ArtifactPreview> },
  { name: "Image", widths: ["375", "app"], render: (context) => <ArtifactPreview><ArtifactPreviewImage alt={text(context).image} src={IMAGE} /></ArtifactPreview> },
  { name: "Frame (PDF, HTML)", render: (context) => <ArtifactPreview><ArtifactPreviewFrame src={PAGE} title={text(context).frame} /></ArtifactPreview> },
  // A scrap opens at the clipped part's own size (intrinsicSize), sandboxed with no scripts.
  { name: "Frame at its own size", widths: ["375", "app"], render: (context) => <ArtifactPreview><ArtifactPreviewFrame src={PART} title={text(context).part} sandbox="" intrinsicSize={{ width: 240, height: 96 }} /></ArtifactPreview> },
  {
    name: "Loading and failed",
    states: ["loading", "error"],
    render: (context) => (
      <>
        <ArtifactPreview><Typo.Caption>{text(context).loading}</Typo.Caption></ArtifactPreview>
        <ArtifactPreview><Typo.Caption>{text(context).failed}</Typo.Caption></ArtifactPreview>
      </>
    ),
  },
  // surface="page": a docked file viewer in the split's right slot is the reading page; the preview draws no box
  // and scrolls with the viewer. PageContainer's gutter plus Box padding give the 48px reading insets.
  {
    name: "Page surface: markdown in a docked viewer",
    widths: ["app", "wide"],
    render: ({ locale }) => <ShellFrameDemo locale={locale} frame="cards" view="file" file="markdown" fileTabs width={1440} height={900} />,
  },
  {
    name: "Page surface: code file",
    widths: ["app", "wide"],
    render: ({ locale }) => <ShellFrameDemo locale={locale} frame="cards" view="file" file="code" width={1440} height={900} />,
  },
  {
    // The image sits frameless on the page, keeping its own corner radius.
    name: "Page surface: image, frameless",
    widths: ["app", "wide"],
    render: ({ locale }) => <ShellFrameDemo locale={locale} frame="cards" view="file" file="image" width={1440} height={900} />,
  },
];

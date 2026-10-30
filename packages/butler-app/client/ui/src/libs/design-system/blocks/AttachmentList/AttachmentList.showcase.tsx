import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { FileText, ImageIcon } from "../../components/Icons";
import { BROKEN_PICTURE, fixturePicture } from "../../components/MediaFrame/fixtures";
import { AttachmentList, type AttachmentListItem } from "./AttachmentList";

export const meta: ShowcaseMeta = {
  title: "AttachmentList",
  category: "Composer",
  tags: ["attachments", "files", "composer", "chips", "tiles"],
  status: "stable",
};

const THUMBNAIL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' fill='%23e9eaec'/%3E%3Cpath d='m4 17 4.5-5 3.5 3 2.5-3 5.5 6H4Z' fill='%2371767d'/%3E%3C/svg%3E";

const labels = {
  "en-US": { preview: "Screenshot preview", empty: "No attachments", notes: "project-notes.md", shot: "settings-375.png", noImages: "Model doesn't accept images",
    lake: "lake.jpg", bowl: "lunch.jpg", report: "q2-revenue-report-final-reviewed.pdf", draft: "contract-draft-v3.docx", license: "LICENSE", broken: "broken-photo.jpg", file: "File",
    remove: (name: string) => `Remove ${name}`, uploading: "Uploading 40%", tooLarge: "Over 10 MB" },
  "ko-KR": { preview: "스크린샷 미리보기", empty: "첨부 파일 없음", notes: "프로젝트-메모.md", shot: "설정-375.png", noImages: "이미지 미지원 모델",
    lake: "호수.jpg", bowl: "점심.jpg", report: "2026년_2분기_매출_보고서_최종.pdf", draft: "계약서_초안_v3.docx", license: "LICENSE", broken: "깨진_사진.jpg", file: "파일",
    remove: (name: string) => `${name} 제거`, uploading: "올리는 중 40%", tooLarge: "10MB 초과" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** A sent message's mixed files: pictures, a PDF, a Word file, an unknown type and a broken picture. */
function tiles(context: ShowcaseRenderContext): AttachmentListItem[] {
  const t = text(context);
  return [
    { id: "lake", name: t.lake, meta: "2.4 MB", thumbnail: { src: fixturePicture("place") } },
    { id: "bowl", name: t.bowl, meta: "1.8 MB", thumbnail: { src: fixturePicture("recipe") } },
    { id: "report", name: t.report, meta: "1.1 MB", extension: "PDF" },
    { id: "draft", name: t.draft, meta: "86 KB", extension: "DOCX" },
    { id: "license", name: t.license, meta: "4 KB", extension: t.file },
    { id: "broken", name: t.broken, meta: "900 KB", extension: "JPG", thumbnail: { src: BROKEN_PICTURE } },
  ];
}

/** A detail's attachments while editing: done, uploading (Spinner) and failed (danger) items. */
function uploads(context: ShowcaseRenderContext): AttachmentListItem[] {
  const [lake, bowl, report, draft] = tiles(context);
  const t = text(context);
  return [lake!, { ...bowl!, meta: t.uploading, upload: "uploading" }, { ...report!, meta: t.uploading, upload: "uploading" },
    { ...draft!, meta: t.tooLarge, upload: "failed" }, { ...lake!, id: "lake-2", meta: t.tooLarge, upload: "failed" }];
}

export const stories: ShowcaseStory[] = [
  {
    // MessageAttachments: sent files as a list with sizes and links.
    name: "Message attachments (list)",
    render: (context) => (
      <AttachmentList items={[
        { id: "a", name: text(context).shot, meta: "142 KB", href: "#", thumbnail: { alt: text(context).preview, src: THUMBNAIL } },
        { id: "b", name: text(context).notes, meta: "4 KB", href: "#" },
      ]} />
    ),
  },
  {
    // ComposerAttachments: removable chips that wrap and truncate long names.
    name: "Composer chips (removable)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <AttachmentList variant="chips" onRemove={() => undefined} items={[
        { id: "image", name: "a-very-long-image-file-name-from-the-design-review.png", meta: "142 KB", icon: <ImageIcon size="sm" />, thumbnail: { alt: text(context).preview, src: THUMBNAIL } },
        { id: "markdown", name: text(context).notes, meta: "4 KB", icon: <FileText size="sm" /> },
        { id: "json", name: "large-export.json", meta: "2 MB" },
        { id: "log", name: "runtime-output.log", meta: "84 KB" },
      ]} />
    ),
  },
  {
    // ComposerAttachments after switching to a text-only model: the image stays, dimmed, and blocks send.
    name: "Composer chips (image blocked)",
    states: ["disabled"],
    render: (context) => (
      <AttachmentList variant="chips" onRemove={() => undefined} items={[
        { id: "image", name: text(context).shot, meta: "142 KB", blockedReason: text(context).noImages, thumbnail: { alt: text(context).preview, src: THUMBNAIL } },
        { id: "markdown", name: text(context).notes, meta: "4 KB", icon: <FileText size="sm" /> },
      ]} />
    ),
  },
  {
    // MessageAttachments: 96px tiles, end-aligned and wrapping; every tile opens in the app (viewer or inspector).
    name: "Message tiles (wrap)",
    widths: ["320", "375", "app"],
    render: (context) => <AttachmentList variant="tiles" tileLayout="wrap" items={tiles(context)} onOpen={() => undefined} />,
  },
  {
    // ComposerAttachments: 64px tiles in one row that scrolls sideways; ✕ on hover/focus, always on touch.
    name: "Composer tiles (row, removable)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <AttachmentList variant="tiles" tileLayout="row" items={[...tiles(context), ...tiles(context).map((item) => ({ ...item, id: `${item.id}-2` }))]}
        onOpen={() => undefined} onRemove={() => undefined} removeLabel={text(context).remove} />
    ),
  },
  {
    // A picture the current model cannot take: greyed, with the reason in its tooltip; still removable.
    name: "Composer tiles (image blocked)",
    states: ["disabled"],
    render: (context) => (
      <AttachmentList variant="tiles" tileLayout="row" onOpen={() => undefined} onRemove={() => undefined} removeLabel={text(context).remove}
        items={[{ ...tiles(context)[0]!, blockedReason: text(context).noImages }, tiles(context)[2]!]} />
    ),
  },
  {
    // A detail pane's description while editing: start-aligned tiles with upload statuses (meta says how far or why).
    name: "Upload statuses (tiles, start-aligned)",
    states: ["loading", "invalid"],
    widths: ["320", "375", "app"],
    render: (context) => <AttachmentList variant="tiles" tileLayout="wrap" tileAlign="start" items={uploads(context)}
      onOpen={() => undefined} onRemove={() => undefined} removeLabel={text(context).remove} />,
  },
  { name: "Upload statuses (list)", states: ["loading", "invalid"], render: (context) => <AttachmentList items={uploads(context).slice(1, 4)} /> },
  { name: "Empty", render: (context) => <AttachmentList emptyLabel={text(context).empty} items={[]} /> },
];

/** Tiles under the forced states: the face's ring and press, the ✕ shown on hover and focus. */
export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  variants: ["Picture", "File"],
  render: (context) => (
    <AttachmentList variant="tiles" tileLayout="row" onOpen={() => undefined} onRemove={() => undefined} removeLabel={text(context).remove}
      items={[tiles(context)[context.variant === "File" ? 2 : 0]!]} />
  ),
};

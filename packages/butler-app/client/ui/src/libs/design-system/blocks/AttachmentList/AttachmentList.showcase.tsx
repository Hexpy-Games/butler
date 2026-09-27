import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText, ImageIcon } from "../../components/Icons";
import { AttachmentList } from "./AttachmentList";

export const meta: ShowcaseMeta = {
  title: "AttachmentList",
  category: "Composer",
  tags: ["attachments", "files", "composer", "chips"],
  status: "stable",
};

const THUMBNAIL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' fill='%23e9eaec'/%3E%3Cpath d='m4 17 4.5-5 3.5 3 2.5-3 5.5 6H4Z' fill='%2371767d'/%3E%3C/svg%3E";

const labels = {
  "en-US": { preview: "Screenshot preview", empty: "No attachments", notes: "project-notes.md", shot: "settings-375.png" },
  "ko-KR": { preview: "스크린샷 미리보기", empty: "첨부 파일 없음", notes: "프로젝트-메모.md", shot: "설정-375.png" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
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
  { name: "Empty", render: (context) => <AttachmentList emptyLabel={text(context).empty} items={[]} /> },
];

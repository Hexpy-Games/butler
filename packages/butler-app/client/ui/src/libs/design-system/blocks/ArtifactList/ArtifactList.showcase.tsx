import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Copy, FileText, ImageIcon, Save } from "../../components/Icons";
import { ArtifactList } from "./ArtifactList";

export const meta: ShowcaseMeta = {
  title: "ArtifactList",
  category: "Documents & Artifacts",
  tags: ["artifacts", "files", "message", "download"],
  status: "stable",
};

const labels = {
  "en-US": { region: "Artifacts", save: "Save", copy: "Copy", document: "document", image: "image", open: "Open" },
  "ko-KR": { region: "산출물", save: "저장", copy: "복사", document: "문서", image: "이미지", open: "열기" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // MessageArtifacts: files attached under an assistant answer.
    name: "Message artifacts",
    widths: ["320", "375", "app"],
    render: (context) => {
      const copy = text(context);
      const save = (file: string) => [{ id: "save", label: copy.save, ariaLabel: `${copy.save}: ${file}`, href: "#", download: file, icon: <Save size="sm" /> }];
      return (
        <ArtifactList aria-label={copy.region} items={[
          { id: "notes", title: "butler-dedicated-client-conversation.md", description: `${copy.document} / 7.8 KB`, icon: <FileText size="lg" />, onOpen: () => undefined, actions: save("conversation.md") },
          { id: "plan", title: "plan-butler-dedicated-client-functional-completion.md", description: `${copy.document} / 5.2 KB`, icon: <FileText size="lg" />, onOpen: () => undefined, actions: save("plan.md") },
          { id: "shot", title: "settings-375.png", description: `${copy.image} / 142 KB`, icon: <ImageIcon size="lg" />, onOpen: () => undefined, actions: save("settings-375.png") },
        ]} />
      );
    },
  },
  {
    // The card's own width decides the layout: actions stay beside a readable
    // name and wrap to a right-aligned row only on a narrow card.
    name: "Card width",
    widths: ["375", "app"],
    render: (context) => {
      const copy = text(context);
      const file = "quarterly-research-summary.md";
      const save = { id: "save", label: copy.save, ariaLabel: `${copy.save}: ${file}`, href: "#", download: file, icon: <Save size="sm" /> };
      const both = [save, { id: "copy", label: copy.copy, ariaLabel: `${copy.copy}: ${file}`, icon: <Copy size="sm" />, onClick: () => undefined }];
      const list = (actions: typeof both) => (
        <ArtifactList aria-label={copy.region} items={[
          { id: "doc", title: file, description: `${copy.document} / 6.1 KB`, icon: <FileText size="lg" />, onOpen: () => undefined, actions },
        ]} />
      );
      return (
        <Stack gap="lg">
          {[240, 440].map(width => (
            <Stack gap="md" key={width} UNSAFE_style={{ maxWidth: `${width}px` }}>
              {list([save])}
              {list(both)}
            </Stack>
          ))}
        </Stack>
      );
    },
  },
  {
    name: "Without actions",
    render: (context) => (
      <ArtifactList aria-label={text(context).region} items={[
        { id: "readme", title: "README.md", description: `${text(context).document} / 2.1 KB`, ariaLabel: `${text(context).open}: README.md`, onOpen: () => undefined },
      ]} />
    ),
  },
];

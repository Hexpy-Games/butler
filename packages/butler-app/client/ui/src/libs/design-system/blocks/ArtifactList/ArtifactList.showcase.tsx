import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText, ImageIcon, Save } from "../../components/Icons";
import { ArtifactList } from "./ArtifactList";

export const meta: ShowcaseMeta = {
  title: "ArtifactList",
  category: "Documents & Artifacts",
  tags: ["artifacts", "files", "message", "download"],
  status: "stable",
};

const labels = {
  "en-US": { region: "Artifacts", save: "Save", document: "document", image: "image", open: "Open" },
  "ko-KR": { region: "산출물", save: "저장", document: "문서", image: "이미지", open: "열기" },
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
    name: "Without actions",
    render: (context) => (
      <ArtifactList aria-label={text(context).region} items={[
        { id: "readme", title: "README.md", description: `${text(context).document} / 2.1 KB`, ariaLabel: `${text(context).open}: README.md`, onOpen: () => undefined },
      ]} />
    ),
  },
];

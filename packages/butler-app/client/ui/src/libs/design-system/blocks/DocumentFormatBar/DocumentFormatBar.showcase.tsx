import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Bold, Heading, ListBullet, Plus } from "../../components/Icons";
import { DocumentFormatBar } from "./DocumentFormatBar";

export const meta: ShowcaseMeta = {
  title: "DocumentFormatBar",
  category: "Documents & Artifacts",
  tags: ["document", "editor", "toolbar", "format"],
  status: "beta",
};

const labels = {
  "en-US": { bar: "Format", bold: "Bold", heading: "Heading", list: "List", block: "Add block" },
  "ko-KR": { bar: "서식", bold: "굵게", heading: "제목", list: "목록", block: "블록 추가" },
} as const;

function Bar({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <div style={{ height: 96 }}>
      <DocumentFormatBar label={copy.bar} anchor={{ top: 140, bottom: 160, left: 160, width: 120 }} actions={[
        { id: "bold", label: copy.bold, icon: <Bold size="sm" />, pressed: true, onPress: () => undefined },
        { id: "heading", label: copy.heading, icon: <Heading size="sm" />, onPress: () => undefined },
        { id: "list", label: copy.list, icon: <ListBullet size="sm" />, onPress: () => undefined },
        { id: "block", label: copy.block, icon: <Plus size="sm" />, onPress: () => undefined },
      ]} />
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Over a selection", states: ["hover", "focus-visible"], widths: ["375", "app"], render: (context) => <Bar context={context} /> },
];

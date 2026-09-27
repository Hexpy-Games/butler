import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Circle, FileText, Plus } from "../../components/Icons";
import { EmptyLine } from "./EmptyLine";

export const meta: ShowcaseMeta = {
  title: "EmptyLine",
  category: "Conversation & Activity",
  tags: ["empty", "placeholder", "inline"],
  status: "stable",
};

const labels = {
  "en-US": { automations: "No automations yet.", artifacts: "No artifacts in this conversation.", sessions: "No conversations yet", create: "New chat" },
  "ko-KR": { automations: "아직 자동화가 없습니다.", artifacts: "이 대화에는 산출물이 없습니다.", sessions: "아직 대화가 없습니다", create: "새 채팅" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  // AutomationsList: message only.
  { name: "Message only", render: (context) => <EmptyLine message={text(context).automations} /> },
  // EmptyPanelLine (inspector panels): a small circle icon.
  { name: "Panel empty line", render: (context) => <EmptyLine icon={<Circle size="md" />} message={text(context).artifacts} /> },
  {
    name: "With icon and action",
    render: (context) => (
      <EmptyLine icon={<FileText size="2xl" />} message={text(context).sessions}
        action={<Button iconStart={<Plus size="md" />} text={text(context).create} />} />
    ),
  },
];

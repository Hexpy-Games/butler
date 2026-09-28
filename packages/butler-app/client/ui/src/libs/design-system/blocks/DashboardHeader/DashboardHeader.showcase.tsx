import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { MessageSquarePlus, Plus } from "../../components/Icons";
import { DashboardHeader } from "./DashboardHeader";

export const meta: ShowcaseMeta = {
  title: "DashboardHeader",
  category: "Dashboard & Metrics",
  tags: ["dashboard", "header", "title", "project"],
  status: "stable",
};

const labels = {
  "en-US": {
    project: "butler", newChat: "New chat", automations: "Schedules", scheduled: "3 scheduled", newAutomation: "New schedule",
    dashboard: "Project dashboard", description: "Work history and project context", chats: "12 project chats",
  },
  "ko-KR": {
    project: "butler", newChat: "새 채팅", automations: "예약 작업", scheduled: "예약 3개", newAutomation: "새 예약 작업",
    dashboard: "프로젝트 대시보드", description: "작업 기록과 프로젝트 맥락", chats: "프로젝트 채팅 12개",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // ProjectDashboardHeader
    name: "Project dashboard",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <DashboardHeader title={text(context).project}
        action={<Button type="button" variant="outline"><MessageSquarePlus size="md" /> {text(context).newChat}</Button>} />
    ),
  },
  {
    // AutomationsList
    name: "Automations list",
    render: (context) => (
      <DashboardHeader title={text(context).automations} meta={text(context).scheduled}
        action={<Button type="button" variant="outline"><Plus size="md" /> {text(context).newAutomation}</Button>} />
    ),
  },
  {
    name: "Description and meta",
    widths: ["320", "375", "app"],
    render: (context) => (
      <DashboardHeader title={text(context).dashboard} description={text(context).description} meta={text(context).chats}
        action={<Button iconStart={<MessageSquarePlus size="md" />} text={text(context).newChat} />} />
    ),
  },
];

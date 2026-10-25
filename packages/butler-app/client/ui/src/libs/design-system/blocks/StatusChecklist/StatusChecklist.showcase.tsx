import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { StatusChecklist } from "./StatusChecklist";

export const meta: ShowcaseMeta = {
  title: "StatusChecklist",
  category: "Conversation & Activity",
  tags: ["checklist", "answer block", "read-only", "todo"],
  status: "stable",
};

const labels = {
  "en-US": ["Book the venue", "Send invitations", "Order the cake", "Confirm the photographer for the afternoon session and send the shot list"],
  "ko-KR": ["장소 예약", "초대장 보내기", "케이크 주문", "오후 촬영 작가 확정하고 촬영 목록 보내기"],
} as const;

function items({ locale }: ShowcaseRenderContext) {
  return labels[locale].map((text, index) => ({ text, done: index < 2 }));
}

export const stories: ShowcaseStory[] = [
  { name: "Answer checklist", widths: ["375", "app"], render: (context) => <StatusChecklist items={items(context)} /> },
];

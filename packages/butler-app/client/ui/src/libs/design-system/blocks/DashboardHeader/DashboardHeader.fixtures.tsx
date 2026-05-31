import { Button } from "../../components/Button";
import { MessageSquarePlus } from "../../components/Icons";
import { DashboardHeader } from "./DashboardHeader";

export function DashboardHeaderFixture() {
  return (
    <DashboardHeader
      title="Project dashboard"
      description="Work history and project context"
      meta="12 project chats"
      action={<Button iconStart={<MessageSquarePlus size={16} />} text="New chat" />}
    />
  );
}

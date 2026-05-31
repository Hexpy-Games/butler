import { MessageSquarePlus } from "@/butler-ds";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { Section, SessionRow, Stack } from "@/butler-ds";
import { relativeAge } from "@/app/utils.ts";
import type { SessionSummary } from "@/app/types.ts";

export function ProjectSessionsPanel({
  sessions,
  onOpenSession,
}: {
  sessions: SessionSummary[];
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <Section
      gap="sm"
      icon={<MessageSquarePlus size={16} />}
      title="Project chats"
    >
      {sessions.length > 0 ? (
        <Stack gap="xs">
          {sessions.map((session) => (
            <SessionRow
              card
              dataTestClass="project-chat-card"
              key={session.id}
              title={session.title}
              meta={relativeAge(session.last_activity_at)}
              showIcon={false}
              onSelect={() => onOpenSession(session.id)}
            />
          ))}
        </Stack>
      ) : (
        <EmptyPanelLine label="No project chats yet" />
      )}
    </Section>
  );
}

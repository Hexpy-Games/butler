import { InlineReference, MessageSquare, Notebook } from "@/butler-ds";
import { useButlerStore } from "@/app/store";

export function SessionReferenceText({ sessionId, title }: { sessionId: string; title: string }) {
  const session = useButlerStore(state => state.navigation.chats.find(chat => chat.id === sessionId) ??
    state.navigation.projects.flatMap(project => project.sessions ?? []).find(chat => chat.id === sessionId));
  const open = useButlerStore(state => state.openSession);
  return <InlineReference icon={session?.project_id ? <Notebook /> : <MessageSquare />}
    unavailable={!session && sessionId !== "general"}
    onClick={session || sessionId === "general" ? () => { void open(sessionId); } : undefined}>
    {title}
  </InlineReference>;
}

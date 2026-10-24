import type { PendingAsk } from "@/app/pendingAsks.ts";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { useState, type ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Card, Clickable, DisclosureRow, KeyValueRow, ListRow, Section, Stack, Typo, type AsideLayout } from "@/butler-ds";
import { useActiveCanonEpic } from "../canon/useActiveCanonEpic.ts";
import { EpicInspector } from "../canon/EpicInspector.tsx";
import { ContextPanel } from "../inspector/ContextPanel.tsx";
import { ArtifactsPanel } from "../inspector/ArtifactsPanel.tsx";
import { AutomationTargetsPanel } from "../inspector/AutomationTargetsPanel.tsx";
import { MessageAttachments } from "../conversation/MessageAttachments.tsx";
import { useMessageNavigation } from "@/app/messageNavigation.ts";
import { usePendingAsks } from "./usePendingAsks.ts";

/** The same ordered sections on the flat margin and on floating glass. */
export function SessionSections({ layout }: { layout: AsideLayout }) {
  useAppLocale();
  const sessionId = useButlerStore(state => state.activeChatId);
  const summary = useButlerStore(state => state.summary?.session_id === sessionId ? state.summary : null);
  const messages = useButlerStore(state => state.messages);
  const queue = useButlerStore(state => state.sessionQueue);
  const setView = useButlerStore(state => state.setView);
  const epic = useActiveCanonEpic();
  const asks = usePendingAsks(sessionId);
  const [contextOpen, setContextOpen] = useState(false);
  const c = appCopy.sessionInfo;
  const branch = summary?.branch_info;
  const folder = branch?.workspace_path || branch?.workspace_label;
  const artifacts = summary?.artifacts ?? [];
  const attachments = [...new Map(messages.flatMap(message => message.attachments ?? []).map(file => [file.file_id, file])).values()];
  const schedules = summary?.automation_targets ?? [];
  const waiting = queue.filter(item => item.chat_id === sessionId && ["queued", "dispatching"].includes(item.state));
  const running = (ACTIVE_TURN_STATES.has(summary?.turn_state ?? "") ? summary?.latest_progress?.safe_progress_rows : [])?.filter(row => ["running", "active", "thinking", "streaming", "reviewing", "waiting_for_tool"].includes(row.state ?? "")) ?? [];
  const hasArtifacts = artifacts.length > 0 || messages.some(message => message.artifacts?.length);
  const selectedArtifact = useButlerStore(state => state.selectedArtifact);
  return <Stack gap="md" data-test-class="session-sections">
    {asks && asks.open_count > 0 && <SessionSection id="asks" layout={layout} title={c.asks}>
      {asks.asks.map(ask => ask.source_message_id ? <Clickable key={ask.ask_id} stretch onClick={() => void openAskSource(ask)}>
        <ListRow title={ask.title} description={ask.summary} />
      </Clickable> : <ListRow key={ask.ask_id} title={ask.title} description={ask.summary} />)}
    </SessionSection>}
    {(folder || branch?.branch_name) && <SessionSection id="environment" layout={layout} title={c.environment}>
      {folder && <KeyValueRow label={c.folder} value={folder} valueTextSize="caption" />}
      {branch?.branch_name && <KeyValueRow label={c.branch} value={branch.branch_name} valueTextSize="caption" />}
    </SessionSection>}
    {epic && <SessionSection id="task" layout={layout} title={appCopy.canon.epic}>
      <EpicInspector embedded projectId={epic.projectId} epicId={epic.epic.id} />
    </SessionSection>}
    {summary?.context_details && <SessionSection id="context" layout={layout}>
      <DisclosureRow surface="plain" title={c.context} meta={`${Math.round(summary.context_details.ratio * 100)}%`}
        open={contextOpen} onToggle={() => setContextOpen(value => !value)} data-test-class="session-context">
        <ContextPanel context={summary.context_details} />
      </DisclosureRow>
    </SessionSection>}
    {(hasArtifacts || selectedArtifact) && <SessionSection id="artifacts" layout={layout}>
      <ArtifactsPanel title={c.artifacts} artifacts={artifacts} />
    </SessionSection>}
    {attachments.length > 0 && <SessionSection id="attachments" layout={layout} title={c.attachments}>
      <MessageAttachments attachments={attachments} sessionId={sessionId} />
    </SessionSection>}
    {schedules.length > 0 && <SessionSection id="schedules" layout={layout}>
      <AutomationTargetsPanel automations={schedules} onOpenAutomation={automationId => setView({ kind: "automation-detail", automationId })} />
    </SessionSection>}
    {(running.length > 0 || waiting.length > 0) && <SessionSection id="queue" layout={layout} title={c.queue}>
      {running.map(row => <Typo.Caption key={row.id} wrap="anywhere">{row.safe_label}</Typo.Caption>)}
      {waiting.map(item => <Typo.Caption key={item.id} wrap="anywhere">{item.text}</Typo.Caption>)}
    </SessionSection>}
  </Stack>;
}

function SessionSection({ id, layout, title, children }: { id: string; layout: AsideLayout; title?: string; children: ReactNode }) {
  const content = title ? <Section title={title} gap="sm">{children}</Section> : children;
  return layout === "docked" ? <Card radius="lg" padding="sm" data-session-section={id}>{content}</Card> : <Stack gap="sm" data-session-section={id}>{content}</Stack>;
}

async function openAskSource(ask: PendingAsk) {
  if (!ask.source_message_id) return;
  const store = useButlerStore.getState();
  if (store.activeChatId !== ask.source_session_id) await store.openSession(ask.source_session_id);
  useMessageNavigation.setState({ target: { sessionId: ask.source_session_id, messageId: ask.source_message_id } });
}

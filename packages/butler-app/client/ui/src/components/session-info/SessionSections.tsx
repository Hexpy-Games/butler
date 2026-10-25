import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { DisclosureRow, KeyValueRow, Typo, type AsideLayout } from "@/butler-ds";
import { useActiveCanonEpic } from "../canon/useActiveCanonEpic.ts";
import { EpicInspector } from "../canon/EpicInspector.tsx";
import { ContextCompact } from "./ContextCompact.tsx";
import { ArtifactsPanel } from "../inspector/ArtifactsPanel.tsx";
import { AutomationTargetsPanel } from "../inspector/AutomationTargetsPanel.tsx";
import { MessageAttachments } from "../conversation/MessageAttachments.tsx";
import { SessionSection, SessionSectionList } from "./SessionSection.tsx";
import { PendingAskRows } from "./PendingAskRows.tsx";
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
  return <SessionSectionList layout={layout}>
    {asks && asks.open_count > 0 && <SessionSection id="asks" layout={layout} title={c.asks} count={asks.open_count}>
      <PendingAskRows asks={asks.asks} />
    </SessionSection>}
    {(folder || branch?.branch_name) && <SessionSection id="environment" layout={layout} title={c.environment}>
      {folder && <KeyValueRow label={c.folder} value={folder} valueTextSize="caption" />}
      {branch?.branch_name && <KeyValueRow label={c.branch} value={branch.branch_name} valueTextSize="caption" />}
    </SessionSection>}
    {epic && <SessionSection id="task" layout={layout} title={appCopy.canon.epic}>
      <EpicInspector embedded projectId={epic.projectId} epicId={epic.epic.id} />
    </SessionSection>}
    {summary?.context_details && <SessionSection id="context" layout={layout}>
      <DisclosureRow surface="plain" title={<Typo.Caption tone="secondary" weight="medium">{c.context}</Typo.Caption>} meta={`${Math.round(summary.context_details.ratio * 100)}%`}
        open={contextOpen} onToggle={() => setContextOpen(value => !value)} data-test-class="session-context">
        <ContextCompact context={summary.context_details} />
      </DisclosureRow>
    </SessionSection>}
    {(hasArtifacts || selectedArtifact) && <SessionSection id="artifacts" layout={layout}>
      <ArtifactsPanel compact artifacts={artifacts} />
    </SessionSection>}
    {attachments.length > 0 && <SessionSection id="attachments" layout={layout} title={c.attachments} count={attachments.length}>
      <MessageAttachments attachments={attachments} sessionId={sessionId} tileAlign="start" />
    </SessionSection>}
    {schedules.length > 0 && <SessionSection id="schedules" layout={layout}>
      <AutomationTargetsPanel compact automations={schedules} onOpenAutomation={automationId => setView({ kind: "automation-detail", automationId })} />
    </SessionSection>}
    {(running.length > 0 || waiting.length > 0) && <SessionSection id="queue" layout={layout} title={c.queue} count={running.length + waiting.length}>
      {running.map(row => <Typo.Caption key={row.id} wrap="anywhere">{row.safe_label}</Typo.Caption>)}
      {waiting.map(item => <Typo.Caption key={item.id} wrap="anywhere">{item.text}</Typo.Caption>)}
    </SessionSection>}
  </SessionSectionList>;
}

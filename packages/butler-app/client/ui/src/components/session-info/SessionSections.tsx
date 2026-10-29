import { BrowserSection } from "./BrowserSection.tsx";
import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { DisclosureRow, KeyValueRow, Typo, type AsideLayout } from "@/butler-ds";
import { EpicInspector } from "../canon/EpicInspector.tsx";
import { ContextCompact } from "./ContextCompact.tsx";
import { ArtifactsPanel } from "../inspector/ArtifactsPanel.tsx";
import { AutomationTargetsPanel } from "../inspector/AutomationTargetsPanel.tsx";
import { MessageAttachments } from "../conversation/MessageAttachments.tsx";
import { SessionSection, SessionSectionList } from "./SessionSection.tsx";
import { PendingAskRows } from "./PendingAskRows.tsx";
import { useSessionSectionsModel } from "./useSessionSectionsModel.ts";

/** The same ordered sections on the flat margin and on floating glass. */
export function SessionSections({ layout }: { layout: AsideLayout }) {
  useAppLocale();
  const { ids, sessionId, summary, epic, asks, browserTabs, branch, folder, artifacts, attachments, schedules, running, waiting } = useSessionSectionsModel();
  const sections = new Set(ids);
  const setView = useButlerStore(state => state.setView);
  const [contextOpen, setContextOpen] = useState(false);
  const c = appCopy.sessionInfo;
  return <SessionSectionList layout={layout}>
    {sections.has("asks") && asks && <SessionSection id="asks" layout={layout} title={c.asks} count={asks.open_count}>
      <PendingAskRows asks={asks.asks} />
    </SessionSection>}
    {/* The model filters it, so a hidden browser section leaves no floating separator. */}
    {sections.has("browser") && <BrowserSection key="browser" layout={layout} session={sessionId} tabs={browserTabs} />}
    {sections.has("environment") && <SessionSection id="environment" layout={layout} title={c.environment}>
      {folder && <KeyValueRow label={c.folder} value={folder} valueTextSize="caption" />}
      {branch?.branch_name && <KeyValueRow label={c.branch} value={branch.branch_name} valueTextSize="caption" />}
    </SessionSection>}
    {sections.has("task") && epic && <SessionSection id="task" layout={layout} title={appCopy.canon.epic}>
      <EpicInspector embedded projectId={epic.projectId} epicId={epic.epic.id} />
    </SessionSection>}
    {sections.has("context") && summary?.context_details && <SessionSection id="context" layout={layout}>
      <DisclosureRow surface="plain" title={<Typo.Caption tone="secondary" weight="medium">{c.context}</Typo.Caption>} meta={`${Math.round(summary.context_details.ratio * 100)}%`}
        open={contextOpen} onToggle={() => setContextOpen(value => !value)} data-test-class="session-context">
        <ContextCompact context={summary.context_details} />
      </DisclosureRow>
    </SessionSection>}
    {sections.has("artifacts") && <SessionSection id="artifacts" layout={layout}>
      <ArtifactsPanel compact artifacts={artifacts} />
    </SessionSection>}
    {sections.has("attachments") && <SessionSection id="attachments" layout={layout} title={c.attachments} count={attachments.length}>
      <MessageAttachments attachments={attachments} sessionId={sessionId} tileAlign="start" />
    </SessionSection>}
    {sections.has("schedules") && <SessionSection id="schedules" layout={layout}>
      <AutomationTargetsPanel compact automations={schedules} onOpenAutomation={automationId => setView({ kind: "automation-detail", automationId })} />
    </SessionSection>}
    {sections.has("queue") && <SessionSection id="queue" layout={layout} title={c.queue} count={running.length + waiting.length}>
      {running.map(row => <Typo.Caption key={row.id} wrap="anywhere">{row.safe_label}</Typo.Caption>)}
      {waiting.map(item => <Typo.Caption key={item.id} wrap="anywhere">{item.text}</Typo.Caption>)}
    </SessionSection>}
  </SessionSectionList>;
}

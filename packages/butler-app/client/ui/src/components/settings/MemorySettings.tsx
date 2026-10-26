import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SettingsActionField, SettingsSection, SurfacePanel, Typo } from "@/butler-ds";
import { PatternsSection } from "./PatternsSection";
import { SettingsPage } from "./SettingsPage";
import { useMemorySummary } from "./hooks/useMemorySummary";
import { useInstructions } from "./hooks/useInstructions";
import { useMemoryOperation } from "./hooks/useMemoryOperation";
import { useProjectMemory } from "./hooks/useProjectMemory";
import { useMemoryReset } from "./hooks/useMemoryReset";
import { MemoryResetButton } from "./MemoryResetButton";
import { cardState } from "./memoryTypes";
import { InstructionsContent } from "./InstructionsSection";
import { ConsolidationFields } from "./ConsolidationSection";
import { useConsolidation } from "./hooks/useConsolidation";
import { MemoryFacts } from "./MemoryFacts";
import { ChatMemoryActions } from "./ChatMemoryActions";
import { RecallSettings } from "./RecallSettings";
import { ChatMemoryBody } from "./ChatMemoryBody";
import { ProjectMemoryBody } from "./ProjectMemoryBody";
import { MemoryModelPreparation } from "./MemoryModelPreparation";

export function MemorySettings() {
  useAppLocale();
  const copy = appCopy.settings;
  const summary = useMemorySummary();
  const instructions = useInstructions(summary.reload);
  const operation = useMemoryOperation(summary.inventory?.operation, summary.reload);
  const project = useProjectMemory(summary.projects);
  const reset = useMemoryReset(summary.inventory?.operation, summary.reload);
  const consolidation = useConsolidation();
  const sharedBusy = operation.busy || Boolean(reset.kind) || consolidation.running;
  const revision = summary.inventory?.revision ?? 0;
  const card = (kind: string) => summary.inventory?.kinds.find((c) => c.kind === kind);
  const chat = card("automatic");
  const profile = card("profile");
  const projectState = summary.projectsState !== "ready" ? summary.projectsState : !summary.projects.length ? "empty" : project.state;
  return <SettingsPage>
    <SettingsSection id="instructions" kind="form" title={copy.pageSections.instructions} description={copy.pageSectionDescriptions.instructions}
      state={instructions.state} emptyMessage={instructions.unavailable ? copy.memory.unavailable : copy.memory.instructionsEmpty} onRetry={instructions.reload}>
      <InstructionsContent instructions={instructions} card={card("pinned")} locked={reset.kind === "project_memory"} />
    </SettingsSection>
    <PatternsSection consentOn={profile?.health.consent_on} />
    <SettingsSection id="chat-memory" kind="form" title={copy.pageSections.chatMemory} description={copy.pageSectionDescriptions.chatMemory}
      state={cardState(summary.state, chat)} emptyMessage={copy.memory.unavailable} onRetry={() => { void summary.reload(true); }}>
      <RecallSettings />
      <ChatMemoryBody card={chat} receipt={operation.receipt} cancel={() => { void operation.cancel(); }}
        free={<ChatMemoryActions busy={operation.busy} locked={Boolean(reset.kind) || consolidation.running} ready={summary.state === "ready" && chat?.item_count != null}
          reclaimable={chat?.health.reclaimable_bytes} start={() => { void operation.start(revision); }} />}
        reset={<MemoryResetButton running={reset.kind === "automatic"} locked={sharedBusy && reset.kind !== "automatic"}
          ready={summary.state === "ready" && chat?.item_count != null} empty={chat?.item_count === 0}
          onClick={() => { void reset.start("automatic", revision, chat); }} />} />
    </SettingsSection>
    <SettingsSection id="memory-cleanup" kind="form" title={copy.pageSections.memoryCleanup} description={copy.pageSectionDescriptions.memoryCleanup}>
      <ConsolidationFields operation={consolidation} locked={operation.busy || Boolean(reset.kind)} />
    </SettingsSection>
    <SettingsSection id="memory-model" kind="form" title={appCopy.firstRun.memoryModel.label}><MemoryModelPreparation /></SettingsSection>
    <SettingsSection id="profile-memory" kind="form" title={copy.pageSections.profileMemory} description={copy.pageSectionDescriptions.profileMemory}
      state={cardState(summary.state, profile)} emptyMessage={copy.memory.unavailable} onRetry={() => { void summary.reload(true); }}>
      <SettingsActionField settingId="reset-profile" label={copy.memory.resetProfileLabel} description={copy.memory.resetProfileDescription}
        action={<MemoryResetButton running={reset.kind === "profile"} locked={sharedBusy && reset.kind !== "profile"}
          ready={summary.state === "ready" && profile?.item_count != null && profile?.pending_count != null}
          empty={profile?.item_count === 0 && profile?.pending_count === 0} onClick={() => { void reset.start("profile", revision, profile); }} />}
        details={<SurfacePanel elevation="subtle"><MemoryFacts card={profile} /></SurfacePanel>}
        meta={profile?.health.consent_on === false && <Typo.Caption tone="secondary">{copy.memory.profileBuildingOff}</Typo.Caption>} />
    </SettingsSection>
    <SettingsSection id="project-memory" kind="form" title={copy.pageSections.projectMemory} description={copy.pageSectionDescriptions.projectMemory}
      state={projectState} emptyMessage={summary.projects.length ? copy.memory.unavailable : copy.memory.noProjects}
      onRetry={() => { void summary.reloadProjects(); void project.reload(); }}>
      <ProjectMemoryBody projects={summary.projects} selected={project.selected} select={project.select} memory={project.memory} locked={Boolean(reset.kind === "project_memory")}
        reset={<MemoryResetButton running={reset.kind === "project_memory"} locked={sharedBusy && reset.kind !== "project_memory"}
          ready={projectState === "ready" && project.memory?.conversations != null && project.memory?.instructions != null}
          empty={!project.memory?.summary_bytes && project.memory?.conversations === 0 && project.memory?.instructions === 0}
          onClick={() => { void reset.start("project_memory", revision, undefined, project.memory,
            summary.projects.find((p) => p.id === project.selected)?.display_name, project.selected); }} />} />
    </SettingsSection>
  </SettingsPage>;
}

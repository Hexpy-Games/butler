import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ButtonContainer, SettingsSection, Stack, Typo } from "@/butler-ds";
import { SettingsPage } from "./SettingsPage";
import { useMemorySummary } from "./hooks/useMemorySummary";
import { useInstructions } from "./hooks/useInstructions";
import { useMemoryOperation } from "./hooks/useMemoryOperation";
import { useProjectMemory } from "./hooks/useProjectMemory";
import { useMemoryReset } from "./hooks/useMemoryReset";
import { MemoryResetButton } from "./MemoryResetButton";
import { cardState } from "./memoryTypes";
import { InstructionRow } from "./InstructionRow";
import { MemoryFacts } from "./MemoryFacts";
import { ChatMemoryActions } from "./ChatMemoryActions";
import { ChatMemoryBody } from "./ChatMemoryBody";
import { ProjectMemoryBody } from "./ProjectMemoryBody";

export function MemorySettings() {
  useAppLocale();
  const copy = appCopy.settings;
  const summary = useMemorySummary();
  const instructions = useInstructions(summary.reload);
  const operation = useMemoryOperation(summary.inventory?.operation, summary.reload);
  const project = useProjectMemory(summary.projects);
  const reset = useMemoryReset(summary.inventory?.operation, summary.reload);
  const sharedBusy = operation.busy || Boolean(reset.kind);
  const revision = summary.inventory?.revision ?? 0;
  const card = (kind: string) => summary.inventory?.kinds.find((c) => c.kind === kind);
  const chat = card("automatic");
  const profile = card("profile");
  const projectState = summary.projectsState !== "ready" ? summary.projectsState : !summary.projects.length ? "empty" : project.state;
  return <SettingsPage>
    <SettingsSection id="instructions" kind="list" title={copy.pageSections.instructions} description={copy.pageSectionDescriptions.instructions}
      state={instructions.state} emptyMessage={instructions.unavailable ? copy.memory.unavailable : copy.memory.instructionsEmpty} onRetry={instructions.reload}>
      <MemoryFacts card={card("pinned")} />
      {instructions.rows.map((item) => <InstructionRow key={item.handle} item={item} deleting={instructions.deleting === item.handle}
        locked={Boolean(instructions.deleting) || reset.kind === "project_memory"} lockReason={reset.kind === "project_memory" ? copy.memory.inUse : undefined} onDelete={() => { void instructions.remove(item); }} />)}
    </SettingsSection>
    <SettingsSection id="chat-memory" kind="status" title={copy.pageSections.chatMemory} description={copy.pageSectionDescriptions.chatMemory}
      state={cardState(summary.state, chat)} emptyMessage={copy.memory.unavailable} onRetry={() => { void summary.reload(true); }}
      actions={<ButtonContainer size="sm">
        <ChatMemoryActions busy={operation.busy} locked={Boolean(reset.kind)} ready={summary.state === "ready" && chat?.item_count != null}
          reclaimable={chat?.health.reclaimable_bytes} start={() => { void operation.start(revision); }} />
        <MemoryResetButton running={reset.kind === "automatic"} locked={sharedBusy && reset.kind !== "automatic"}
          ready={summary.state === "ready" && chat?.item_count != null} empty={chat?.item_count === 0}
          onClick={() => { void reset.start("automatic", revision, chat); }} />
      </ButtonContainer>}>
      <ChatMemoryBody card={chat} receipt={operation.receipt} cancel={() => { void operation.cancel(); }} />
    </SettingsSection>
    <SettingsSection id="profile-memory" kind="status" title={copy.pageSections.profileMemory} description={copy.pageSectionDescriptions.profileMemory}
      state={cardState(summary.state, profile)} emptyMessage={copy.memory.unavailable} onRetry={() => { void summary.reload(true); }}
      actions={<MemoryResetButton running={reset.kind === "profile"} locked={Boolean(reset.kind)}
        ready={summary.state === "ready" && profile?.item_count != null && profile?.pending_count != null}
        empty={profile?.item_count === 0 && profile?.pending_count === 0} onClick={() => { void reset.start("profile", revision, profile); }} />} >
      <Stack gap="sm"><MemoryFacts card={profile} />
        {profile?.health.consent_on === false && <Typo.Caption tone="secondary">{copy.memory.profileBuildingOff}</Typo.Caption>}
      </Stack>
    </SettingsSection>
    <SettingsSection id="project-memory" kind="status" title={copy.pageSections.projectMemory} description={copy.pageSectionDescriptions.projectMemory}
      state={projectState} emptyMessage={summary.projects.length ? copy.memory.unavailable : copy.memory.noProjects}
      onRetry={() => { void summary.reloadProjects(); void project.reload(); }}
      actions={<MemoryResetButton running={reset.kind === "project_memory"} locked={sharedBusy && reset.kind !== "project_memory"}
        ready={projectState === "ready" && project.memory?.conversations != null && project.memory?.instructions != null}
        empty={!project.memory?.summary_bytes && project.memory?.conversations === 0 && project.memory?.instructions === 0}
        onClick={() => { void reset.start("project_memory", revision, undefined, project.memory,
          summary.projects.find((p) => p.id === project.selected)?.display_name, project.selected); }} />} >
      <ProjectMemoryBody projects={summary.projects} selected={project.selected} select={project.select} memory={project.memory} locked={Boolean(reset.kind === "project_memory")} />
    </SettingsSection>
  </SettingsPage>;
}

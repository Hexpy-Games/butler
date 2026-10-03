import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SettingsSection, Stack, Typo } from "@/butler-ds";
import { SettingsPage } from "./SettingsPage";
import { useMemorySummary } from "./hooks/useMemorySummary";
import { useInstructions } from "./hooks/useInstructions";
import { useMemoryOperation } from "./hooks/useMemoryOperation";
import { useProjectMemory } from "./hooks/useProjectMemory";
import { cardState } from "./memoryTypes";
import { InstructionRow } from "./InstructionRow";
import { RecentFeedback } from "./RecentFeedback";
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
  const card = (kind: string) => summary.inventory?.kinds.find((c) => c.kind === kind);
  const chat = card("automatic");
  const profile = card("profile");
  const projectState = summary.projectsState !== "ready" ? summary.projectsState : !summary.projects.length ? "empty" : project.state;
  return <SettingsPage>
    <SettingsSection id="instructions" kind="list" title={copy.pageSections.instructions} description={copy.pageSectionDescriptions.instructions}
      state={instructions.state} emptyMessage={instructions.unavailable ? copy.memory.unavailable : copy.memory.instructionsEmpty} onRetry={instructions.reload}>
      <MemoryFacts card={card("pinned")} />
      {instructions.rows.map((item) => <InstructionRow key={item.handle} item={item} deleting={instructions.deleting === item.handle}
        locked={Boolean(instructions.deleting)} onDelete={() => { void instructions.remove(item); }} />)}
    </SettingsSection>
    <RecentFeedback projects={summary.projects} />
    <SettingsSection id="chat-memory" kind="status" title={copy.pageSections.chatMemory} description={copy.pageSectionDescriptions.chatMemory}
      state={cardState(summary.state, chat)} emptyMessage={copy.memory.unavailable} onRetry={() => { void summary.reload(true); }}
      actions={<ChatMemoryActions busy={operation.busy} ready={summary.state === "ready" && chat?.item_count != null}
        reclaimable={chat?.health.reclaimable_bytes} start={() => { if (summary.inventory) void operation.start(summary.inventory.revision); }} />}>
      <ChatMemoryBody card={chat} receipt={operation.receipt} cancel={() => { void operation.cancel(); }} />
    </SettingsSection>
    <SettingsSection id="profile-memory" kind="status" title={copy.pageSections.profileMemory} description={copy.pageSectionDescriptions.profileMemory}
      state={cardState(summary.state, profile)} emptyMessage={copy.memory.unavailable} onRetry={() => { void summary.reload(true); }}>
      <Stack gap="sm"><MemoryFacts card={profile} />
        {profile?.health.consent_on === false && <Typo.Caption tone="secondary">{copy.memory.profileBuildingOff}</Typo.Caption>}
      </Stack>
    </SettingsSection>
    <SettingsSection id="project-memory" kind="status" title={copy.pageSections.projectMemory} description={copy.pageSectionDescriptions.projectMemory}
      state={projectState} emptyMessage={summary.projects.length ? copy.memory.unavailable : copy.memory.noProjects}
      onRetry={() => { void summary.reloadProjects(); void project.reload(); }}>
      <ProjectMemoryBody projects={summary.projects} selected={project.selected} select={project.select} memory={project.memory} />
    </SettingsSection>
  </SettingsPage>;
}

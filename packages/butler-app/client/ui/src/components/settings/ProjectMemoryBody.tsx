import { Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import { MemoryFacts } from "./MemoryFacts";
import type { MemoryProject, ProjectMemory } from "./memoryTypes";
export function ProjectMemoryBody({ projects, selected, select, memory }: {
  projects: MemoryProject[]; selected: string; select: (id: string) => void; memory?: ProjectMemory;
}) {
  return <Stack gap="md">
    <SettingsSelect settingId="memory-project" label={appCopy.settings.memory.project}
      value={selected} onChange={select} options={projects.map((p) => ({ value: p.id, label: p.display_name }))} />
    <MemoryFacts project={memory} />
  </Stack>;
}

import type { ReactElement } from "react";
import { SettingsActionField, SurfacePanel } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import { MemoryFacts } from "./MemoryFacts";
import type { MemoryProject, ProjectMemory } from "./memoryTypes";
export function ProjectMemoryBody({ projects, selected, select, memory, locked, reset }: {
  projects: MemoryProject[]; selected: string; select: (id: string) => void; memory?: ProjectMemory; locked?: boolean; reset: ReactElement;
}) {
  const copy = appCopy.settings.memory;
  return <>
    <SettingsSelect settingId="memory-project" label={copy.project}
      disabled={locked} value={selected} onChange={select} options={projects.map((p) => ({ value: p.id, label: p.display_name }))} />
    <SettingsActionField settingId="reset-project-memory" label={copy.resetProjectLabel} description={copy.resetProjectDescription} action={reset}
      details={<SurfacePanel elevation="subtle"><MemoryFacts project={memory} /></SurfacePanel>} />
  </>;
}

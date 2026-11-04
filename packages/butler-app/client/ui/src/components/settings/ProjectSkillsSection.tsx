import { useId } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { SkillProjectView } from "@/app/types.ts";
import { FieldError, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, type SettingsSectionState } from "@/butler-ds";
import { SettingsSection } from "./SettingsFormComponents";
import { SkillActions } from "./SkillActions";
import { SkillGroup } from "./SkillGroup";

/** Project skills: the project picker filters the list; import and create add to the picked project. */
export function ProjectSkillsSection({
  state,
  projects,
  project,
  error,
  onProject,
  onImport,
  onCreate,
  onRetry,
}: {
  state: SettingsSectionState;
  projects: SkillProjectView[];
  project: SkillProjectView | undefined;
  error?: string;
  onProject: (id: string) => void;
  onImport: (project: SkillProjectView) => void;
  onCreate: (project: SkillProjectView) => void;
  onRetry: () => void;
}) {
  useAppLocale();
  const errorId = useId();
  const copy = appCopy.interfaceDetails;
  const shownState = state === "ready" && (!project || !project.skills.length) && !error ? "empty" : state;
  return (
    <SettingsSection id="project-skills" kind="list" title={appCopy.settings.pageSections.projectSkills}
      state={shownState} onRetry={onRetry}
      emptyMessage={project ? copy.noSkills : appCopy.settings.memory.noProjects}
      actions={project ? (
        <>
          <Select value={project.id} onValueChange={onProject}>
            <SelectTrigger size="sm" aria-label={copy.project}><SelectValue /></SelectTrigger>
            <SelectContent>
              {projects.map((item) => <SelectItem key={item.id} value={item.id}>{item.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <SkillActions errorId={error ? errorId : undefined} onImport={() => onImport(project)} onCreate={() => onCreate(project)} />
        </>
      ) : undefined}>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      {project?.skills.length ? <SkillGroup skills={project.skills} /> : null}
    </SettingsSection>
  );
}

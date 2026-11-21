import { useCallback, useEffect, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { ListRow, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsGroup, SettingsScreen } from "@/settings/layout";
import { SelectRow } from "@/settings/rows";
import type { SkillSettingsView, SkillSummaryView } from "@/settings/types";

export default function SkillsSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings;
  const { client, reconcile } = useConversation();
  const [view, setView] = useState<SkillSettingsView | null>(null), [error, setError] = useState(false), [selected, select] = useState("");
  const reload = useCallback(() => {
    if (!client) return;
    setError(false);
    void client.request<SkillSettingsView>("/skills").then(setView).catch(() => setError(true));
  }, [client]);
  useEffect(reload, [reload, reconcile]);
  const project = view?.projects.find(p => p.id === selected) ?? view?.projects[0];
  return <SettingsScreen title={S.sections.skills} description={S.sectionDescriptions.skills}>
    {!view ? <LoadState error={error} onRetry={reload} /> : <>
      <SettingsGroup title={S.pageSections.coreSkills}><SkillRows skills={view.core} /></SettingsGroup>
      <SettingsGroup title={S.pageSections.userSkills}><SkillRows skills={view.user} /></SettingsGroup>
      <SettingsGroup title={S.pageSections.projectSkills}>
        {project ? <><SelectRow title={app.interfaceDetails.project} value={project.id} options={view.projects.map(p => ({ value: p.id, label: p.display_name }))} onSelect={select} />
          <SkillRows skills={project.skills} /></> : <Text variant="caption">{S.memory.noProjects}</Text>}
      </SettingsGroup>
    </>}
  </SettingsScreen>;
}

function SkillRows({ skills }: { skills: SkillSummaryView[] }) {
  const app = getAppCopy(useAppLocale());
  return skills.length ? <>{skills.map(skill => <ListRow key={skill.file_path} title={skill.name} description={skill.description || skill.file_path} />)}</>
    : <Text variant="caption">{app.interfaceDetails.noSkills}</Text>;
}

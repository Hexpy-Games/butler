import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import { useSettings } from "@/settings/useSettings";
import { useMemoryData } from "@/settings/memory/useMemoryData";
import { useMemoryOps } from "@/settings/memory/useMemoryOps";
import { InstructionsGroup, PatternsGroup } from "@/settings/memory/MemoryLists";
import { ChatMemoryGroup, ProfileMemoryGroup, ProjectMemoryGroup } from "@/settings/memory/MemoryActions";
import { ConsolidationGroup } from "@/settings/memory/ConsolidationGroup";
import { MemoryModelRow } from "@/settings/memory/MemoryModelRow";

export default function MemorySettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, error, reload } = useSettings();
  const data = useMemoryData(), ops = useMemoryOps(data);
  return <SettingsScreen title={S.sections.memory} description={S.sectionDescriptions.memory}>
    {!settings ? <LoadState error={error} onRetry={reload} /> : <>
      <InstructionsGroup data={data} locked={ops.resetKind === "project_memory"} />
      <PatternsGroup data={data} />
      <ChatMemoryGroup data={data} ops={ops} />
      <ConsolidationGroup data={data} ops={ops} />
      <MemoryModelRow data={data} />
      <ProfileMemoryGroup data={data} ops={ops} />
      <ProjectMemoryGroup data={data} ops={ops} />
    </>}
  </SettingsScreen>;
}

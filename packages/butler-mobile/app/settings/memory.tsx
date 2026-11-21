import { ListGroup } from "@/ds";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import { useSettings } from "@/settings/useSettings";
import { useMemoryData } from "@/settings/memory/useMemoryData";
import { useMemoryOps } from "@/settings/memory/useMemoryOps";
import { InstructionsGroup, PatternsGroup } from "@/settings/memory/MemoryLists";
import { ChatMemoryGroup, ResetGroup } from "@/settings/memory/MemoryActions";

export default function MemorySettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, error, reload } = useSettings();
  const data = useMemoryData(), ops = useMemoryOps(data);
  return <SettingsScreen title={S.sections.memory}>
    {!settings ? <ListGroup><LoadState error={error} onRetry={reload} /></ListGroup> : <>
      <InstructionsGroup data={data} locked={ops.resetKind === "project_memory"} />
      <PatternsGroup data={data} />
      <ChatMemoryGroup data={data} ops={ops} />
      <ResetGroup data={data} ops={ops} />
    </>}
  </SettingsScreen>;
}

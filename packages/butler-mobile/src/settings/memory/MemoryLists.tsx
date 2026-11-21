import { useState } from "react";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { GatewayError } from "../../../../butler-protocol/src/client/index.ts";
import { useConversation } from "@/conversation/live";
import { ListGroup, Button, IconButton, icons, ListRow, Sheet, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LoadState } from "../layout";
import { SelectRow, TimeRow } from "../rows";
import { useSettings } from "../useSettings";
import { uuid } from "../format";
import type { Instruction, NoticedPattern } from "../types";
import type { useMemoryData } from "./useMemoryData";
import { instructionMeta, instructionScope } from "./memoryFormat";

type Data = ReturnType<typeof useMemoryData>;
export function InstructionsGroup({ data, locked }: { data: Data; locked: boolean }) {
  const locale = useAppLocale(), app = getAppCopy(locale), S = app.settings, M = useMobileCopy();
  const { client } = useConversation();
  const [selected, select] = useState<Instruction>();
  const [deleting, setDeleting] = useState<string>();
  const remove = async () => {
    if (!client || !selected || deleting || locked) return;
    setDeleting(selected.handle);
    try {
      await client.request(`/memory/instructions/${selected.handle}`, { method: "DELETE",
        body: { expected_revision: selected.revision, project_id: selected.project_id, operation_id: uuid() } });
      select(undefined); showToast({ message: S.memory.instructionDeleted, tone: "success" }); await data.reload();
    } catch { showToast({ message: S.memory.deleteFailed, tone: "error" }); }
    finally { setDeleting(undefined); }
  };
  return <ListGroup label={S.pageSections.instructions}>
    {!data.instructions || data.errors.instructions ? <LoadState error={Boolean(data.errors.instructions)} onRetry={data.reload} />
      : data.instructions.instructions.length ? data.instructions.instructions.map(item => <ListRow key={item.handle} title={item.text} titleLines={2}
        description={instructionMeta(item, S.memory)} meta={locked ? S.memory.inUse : undefined}
        trailing={<IconButton icon={icons.Delete} variant="ghost" label={app.common.delete} loading={deleting === item.handle}
          disabled={locked || Boolean(deleting)} onPress={() => select(item)} />} />)
        : <ListRow title={data.unavailable ? S.memory.unavailable : S.memory.instructionsEmpty} />}
    <Sheet open={Boolean(selected)} onClose={() => select(undefined)} title={S.memory.deleteInstructionTitle}
      description={S.memory.chatsKept} cancelLabel={M.settings.cancel}
      action={<Button variant="destructive" label={app.common.delete} loading={Boolean(deleting)} disabled={locked} onPress={() => void remove()} />}>
      {selected ? <ListRow title={selected.text} description={instructionScope(selected, S.memory)} /> : null}
    </Sheet>
  </ListGroup>;
}

export function PatternsGroup({ data }: { data: Data }) {
  const app = getAppCopy(useAppLocale()), S = app.settings, M = useMobileCopy();
  const { client } = useConversation(), { settings, update } = useSettings();
  const [selected, select] = useState<NoticedPattern>();
  const [deleting, setDeleting] = useState<string>();
  const remove = async () => {
    if (!client || !selected || deleting || !data.patterns) return;
    setDeleting(selected.id);
    try {
      await client.request(`/memory/patterns/${encodeURIComponent(selected.id)}`, { method: "DELETE", body: { expected_revision: data.patterns.revision } });
      select(undefined); showToast({ message: S.memory.patternDeleted, tone: "success" }); await data.reload();
    } catch (error) {
      if (error instanceof GatewayError && error.status === 409) await data.reload();
      showToast({ message: S.memory.deleteFailed, tone: "error" });
    } finally { setDeleting(undefined); }
  };
  return <>
    <ListGroup label={S.pageSections.noticedPatterns}>
      {!data.patterns || data.errors.patterns ? <LoadState error={Boolean(data.errors.patterns)} onRetry={data.reload} />
        : data.patterns.patterns.length ? data.patterns.patterns.map(item => <ListRow key={item.id} title={item.title}
          trailing={<IconButton icon={icons.Delete} label={app.common.delete} loading={deleting === item.id} disabled={Boolean(deleting)} onPress={() => select(item)} />} />)
          : <ListRow title={S.memory.patternsEmpty} />}
      <Sheet open={Boolean(selected)} onClose={() => select(undefined)} title={S.memory.deletePatternTitle}
        description={S.memory.deletePatternBody} cancelLabel={M.settings.cancel}
        action={<Button variant="destructive" label={app.common.delete} loading={Boolean(deleting)} onPress={() => void remove()} />}>
        {selected ? <ListRow title={selected.title} /> : null}
      </Sheet>
    </ListGroup>
    <ListGroup>
      <SelectRow title={S.memory.proactiveLevel} value={settings?.proactive_level ?? "sometimes"}
        options={[{ value: "off", label: S.memory.proactiveOff }, { value: "sometimes", label: S.memory.proactiveSometimes }, { value: "often", label: S.memory.proactiveOften }]}
        onSelect={proactive_level => void update({ proactive_level })} />
      <TimeRow title={S.memory.quietHoursStart} value={settings?.quiet_hours_start ?? "22:00"}
        onChange={quiet_hours_start => void update({ quiet_hours_start })} />
      <TimeRow title={S.memory.quietHoursEnd} value={settings?.quiet_hours_end ?? "07:00"} onChange={quiet_hours_end => void update({ quiet_hours_end })} />
    </ListGroup>
  </>;
}

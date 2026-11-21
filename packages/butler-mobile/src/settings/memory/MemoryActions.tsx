import { useState } from "react";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { Button, ListGroup, ListGroupItem, ListRow, Sheet, Text } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LoadState } from "../layout";
import { SelectRow } from "../rows";
import { useSettings } from "../useSettings";
import type { MemoryCard } from "../types";
import type { useMemoryData } from "./useMemoryData";
import type { ResetKind, useMemoryOps } from "./useMemoryOps";

type Props = { data: ReturnType<typeof useMemoryData>; ops: ReturnType<typeof useMemoryOps> };
export function ChatMemoryGroup({ data, ops }: Props) {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, update } = useSettings();
  const card = data.inventory?.kinds.find(c => c.kind === "automatic");
  return <ListGroup label={S.pageSections.chatMemory}>
    {!data.inventory || data.errors.inventory ? <LoadState error={Boolean(data.errors.inventory)} onRetry={data.reload} />
      : card?.health.state === "unavailable" ? <ListGroupItem><Text variant="caption">{S.memory.unavailable}</Text></ListGroupItem> : <>
        <SelectRow title={S.fields.recallMode} value={settings?.recall_mode ?? "faster"}
          options={[{ value: "faster", label: S.recallOptions.faster }, { value: "accurate", label: S.recallOptions.accurate }]}
          onSelect={recall_mode => void update({ recall_mode })} />
        <ResetAction ops={ops} kind="automatic" card={card} ready={card?.item_count != null} empty={card?.item_count === 0} />
      </>}
  </ListGroup>;
}

export function ProfileMemoryGroup({ data, ops }: Props) {
  const S = getAppCopy(useAppLocale()).settings;
  const card = data.inventory?.kinds.find(c => c.kind === "profile");
  return <ListGroup label={S.pageSections.profileMemory}>
    {!data.inventory || data.errors.inventory ? <LoadState error={Boolean(data.errors.inventory)} onRetry={data.reload} />
      : card?.health.state === "unavailable" ? <ListGroupItem><Text variant="caption">{S.memory.unavailable}</Text></ListGroupItem>
      : <ResetAction ops={ops} kind="profile" card={card} ready={card?.item_count != null && card?.pending_count != null}
        empty={card?.item_count === 0 && card?.pending_count === 0} />}
  </ListGroup>;
}

function ResetAction({ ops, kind, card, ready, empty }: { ops: Props["ops"]; kind: ResetKind; card?: MemoryCard; ready: boolean; empty: boolean }) {
  const S = getAppCopy(useAppLocale()).settings.memory, M = useMobileCopy();
  const [open, setOpen] = useState(false);
  const profile = kind === "profile";
  const running = ops.resetKind === kind, locked = ops.sharedBusy && !running;
  return <>
    <ListRow title={profile ? S.resetProfileLabel : S.resetChatLabel} meta={locked ? S.inUse : empty ? S.nothingToReset : undefined}
      trailing={<Button size="sm" variant="outline" label={S.reset} loading={running} disabled={running || locked || !ready || empty} onPress={() => setOpen(true)} />} />
    <Sheet open={open} onClose={() => setOpen(false)} title={profile ? S.resetProfileTitle : S.resetChatTitle}
      description={profile ? S.resetProfileBody : S.resetBody} cancelLabel={M.settings.cancel}
      action={<Button variant="destructive" label={S.reset} disabled={ops.sharedBusy || !ready || empty} onPress={() => { setOpen(false); void ops.start(kind); }} />}>
      <ListRow title={S.removed} description={profile ? S.removedProfile(card?.item_count ?? 0, card?.pending_count ?? 0) : S.removedChat(card?.item_count ?? 0)} />
      <ListRow title={S.kept} description={profile ? S.keptProfile : S.keptChat} />
      <Text variant="caption">{S.resetNote}</Text>
    </Sheet>
  </>;
}

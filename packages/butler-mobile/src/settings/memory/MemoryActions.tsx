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
export function ChatMemoryGroup({ data }: Props) {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, update } = useSettings();
  const card = data.inventory?.kinds.find(c => c.kind === "automatic");
  return <ListGroup label={S.pageSections.chatMemory}>
    {!data.inventory || data.errors.inventory ? <LoadState error={Boolean(data.errors.inventory)} onRetry={data.reload} />
      : card?.health.state === "unavailable" ? <ListGroupItem><Text variant="caption">{S.memory.unavailable}</Text></ListGroupItem>
      : <SelectRow title={S.fields.recallMode} value={settings?.recall_mode ?? "faster"}
          options={[{ value: "faster", label: S.recallOptions.faster }, { value: "accurate", label: S.recallOptions.accurate }]}
          onSelect={recall_mode => void update({ recall_mode })} />}
  </ListGroup>;
}

export function ResetGroup({ data, ops }: Props) {
  const automatic = data.inventory?.kinds.find(c => c.kind === "automatic");
  const profile = data.inventory?.kinds.find(c => c.kind === "profile");
  return <ListGroup>
    {!data.inventory || data.errors.inventory ? <LoadState error={Boolean(data.errors.inventory)} onRetry={data.reload} />
      : <>
        {automatic?.health.state !== "unavailable" ? <ResetAction ops={ops} kind="automatic" card={automatic}
          ready={automatic?.item_count != null} empty={automatic?.item_count === 0} /> : null}
        {profile?.health.state !== "unavailable" ? <ResetAction ops={ops} kind="profile" card={profile}
          ready={profile?.item_count != null && profile?.pending_count != null} empty={profile?.item_count === 0 && profile?.pending_count === 0} /> : null}
      </>}
  </ListGroup>;
}

function ResetAction({ ops, kind, card, ready, empty }: { ops: Props["ops"]; kind: ResetKind; card?: MemoryCard; ready: boolean; empty: boolean }) {
  const S = getAppCopy(useAppLocale()).settings.memory, M = useMobileCopy();
  const [open, setOpen] = useState(false);
  const profile = kind === "profile";
  const running = ops.resetKind === kind, locked = ops.sharedBusy && !running;
  return <>
    <ListRow title={profile ? S.resetProfileLabel : S.resetChatLabel} destructive disabled={running || locked || !ready || empty} onPress={() => setOpen(true)} />
    <Sheet open={open} onClose={() => setOpen(false)} title={profile ? S.resetProfileTitle : S.resetChatTitle}
      description={profile ? S.resetProfileBody : S.resetBody} cancelLabel={M.settings.cancel}
      action={<Button variant="destructive" label={S.reset} disabled={ops.sharedBusy || !ready || empty} onPress={() => { setOpen(false); void ops.start(kind); }} />}>
      <ListRow title={S.removed} description={profile ? S.removedProfile(card?.item_count ?? 0, card?.pending_count ?? 0) : S.removedChat(card?.item_count ?? 0)} />
      <ListRow title={S.kept} description={profile ? S.keptProfile : S.keptChat} />
      <Text variant="caption">{S.resetNote}</Text>
    </Sheet>
  </>;
}

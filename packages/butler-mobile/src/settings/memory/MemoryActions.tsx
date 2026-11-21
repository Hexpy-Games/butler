import { useState } from "react";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { Button, ListRow, Sheet, Text } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { GroupInset, SettingsGroup, LoadState } from "../layout";
import { SelectRow } from "../rows";
import { useSettings } from "../useSettings";
import { modelDisplayName, runtimeModels, useModelCatalog } from "../useModelCatalog";
import { formatFileSize } from "../format";
import type { MemoryCard } from "../types";
import type { useMemoryData } from "./useMemoryData";
import type { ResetKind, useMemoryOps } from "./useMemoryOps";
import { facts } from "./memoryFormat";

type Props = { data: ReturnType<typeof useMemoryData>; ops: ReturnType<typeof useMemoryOps> };
export function ChatMemoryGroup({ data, ops }: Props) {
  const locale = useAppLocale(), app = getAppCopy(locale), S = app.settings;
  const { settings, update } = useSettings(), { catalog, error, reload } = useModelCatalog();
  const card = data.inventory?.kinds.find(c => c.kind === "automatic");
  const ready = Boolean(data.inventory && !data.errors.inventory && card?.item_count != null);
  const locked = Boolean(ops.resetKind) || ops.consolidating;
  const reason = locked ? S.memory.inUse : card?.health.reclaimable_bytes === 0 ? S.memory.nothingToFree : undefined;
  return <SettingsGroup title={S.pageSections.chatMemory} description={S.pageSectionDescriptions.chatMemory}>
    {!data.inventory || data.errors.inventory ? <GroupInset><LoadState error={Boolean(data.errors.inventory)} onRetry={data.reload} /></GroupInset>
      : card?.health.state === "unavailable" ? <GroupInset><Text variant="caption">{S.memory.unavailable}</Text></GroupInset> : <>
        <SelectRow title={S.fields.recallMode} description={S.descriptions.recallMode} value={settings?.recall_mode ?? "faster"}
          options={[{ value: "faster", label: S.recallOptions.faster }, { value: "accurate", label: S.recallOptions.accurate }]}
          onSelect={recall_mode => void update({ recall_mode })} />
        {settings?.recall_mode === "accurate" ? catalog ? <SelectRow title={S.fields.recallModel} value={settings.recall_judge_model}
          options={[{ value: "default", label: S.recallOptions.sameAsMemoryModel }, ...runtimeModels(catalog).filter(m => m.registered === true && m.enabled !== false)
            .map(m => ({ value: m.model_ref, label: `${m.provider_label} / ${modelDisplayName(m, locale)}` }))]}
          onSelect={recall_judge_model => void update({ recall_judge_model })} /> : <GroupInset><LoadState error={error} onRetry={reload} /></GroupInset> : null}
        <ListRow title={S.memory.storageLabel} description={S.memory.freeSpaceDescription} meta={reason}
          trailing={<Button size="sm" variant="outline" label={S.memory.freeSpace} loading={ops.busy}
            disabled={ops.busy || locked || !ready || card?.health.reclaimable_bytes === 0} onPress={() => void ops.start("cleanup")} />} />
        <GroupInset><Text variant="caption">{facts(card, undefined, app, locale)}</Text></GroupInset>
        {ops.receipt ? <><GroupInset><Text variant="caption">{ops.receipt.phase === "preparing" ? S.memory.freeWaiting : S.memory.freeing(formatFileSize(ops.receipt.bytes_reclaimed))}</Text></GroupInset>
          <GroupInset><Button label={app.common.cancel} onPress={() => void ops.cancel()} /></GroupInset></> : null}
        <ResetAction data={data} ops={ops} kind="automatic" card={card} ready={ready} empty={card?.item_count === 0} />
      </>}
  </SettingsGroup>;
}

export function ProfileMemoryGroup({ data, ops }: Props) {
  const locale = useAppLocale(), app = getAppCopy(locale), S = app.settings;
  const card = data.inventory?.kinds.find(c => c.kind === "profile");
  return <SettingsGroup title={S.pageSections.profileMemory} description={S.pageSectionDescriptions.profileMemory}>
    {!data.inventory || data.errors.inventory ? <GroupInset><LoadState error={Boolean(data.errors.inventory)} onRetry={data.reload} /></GroupInset>
      : card?.health.state === "unavailable" ? <GroupInset><Text variant="caption">{S.memory.unavailable}</Text></GroupInset> : <>
        <ResetAction data={data} ops={ops} kind="profile" card={card} ready={card?.item_count != null && card?.pending_count != null}
          empty={card?.item_count === 0 && card?.pending_count === 0} />
        <GroupInset><Text variant="caption">{facts(card, undefined, app, locale)}</Text></GroupInset>
        {card?.health.consent_on === false ? <GroupInset><Text variant="caption">{S.memory.profileBuildingOff}</Text></GroupInset> : null}
      </>}
  </SettingsGroup>;
}

export function ProjectMemoryGroup({ data, ops }: Props) {
  const locale = useAppLocale(), app = getAppCopy(locale), S = app.settings;
  return <SettingsGroup title={S.pageSections.projectMemory} description={S.pageSectionDescriptions.projectMemory}>
    {!data.projects || data.errors.projects ? <GroupInset><LoadState error={Boolean(data.errors.projects)} onRetry={data.reload} /></GroupInset>
      : !data.projects.length ? <GroupInset><Text variant="caption">{S.memory.noProjects}</Text></GroupInset> : <>
        <SelectRow title={S.memory.project} value={data.selected} options={data.projects.map(p => ({ value: p.id, label: p.display_name }))}
          disabled={ops.resetKind === "project_memory"} onSelect={data.select} />
        {!data.project || data.errors.project ? <GroupInset><LoadState error={Boolean(data.errors.project)} onRetry={data.reload} /></GroupInset> : <>
          <ResetAction data={data} ops={ops} kind="project_memory" ready={data.project.conversations != null && data.project.instructions != null}
            empty={!data.project.summary_bytes && data.project.conversations === 0 && data.project.instructions === 0} />
          <GroupInset><Text variant="caption">{facts(undefined, data.project, app, locale)}</Text></GroupInset>
        </>}
      </>}
  </SettingsGroup>;
}

function ResetAction({ data, ops, kind, card, ready, empty }: Props & { kind: ResetKind; card?: MemoryCard; ready: boolean; empty: boolean }) {
  const S = getAppCopy(useAppLocale()).settings.memory, M = useMobileCopy();
  const [open, setOpen] = useState(false);
  const project = kind === "project_memory", profile = kind === "profile";
  const title = project ? S.resetProjectTitle : profile ? S.resetProfileTitle : S.resetChatTitle;
  const body = project ? S.resetProjectBody : profile ? S.resetProfileBody : S.resetBody;
  const removed = project ? S.removedProject(data.project?.conversations ?? 0, data.project?.instructions ?? 0)
    : profile ? S.removedProfile(card?.item_count ?? 0, card?.pending_count ?? 0) : S.removedChat(card?.item_count ?? 0);
  const kept = project ? S.keptProject : profile ? S.keptProfile : S.keptChat;
  const running = ops.resetKind === kind, locked = ops.sharedBusy && !running;
  return <>
    <ListRow title={project ? S.resetProjectLabel : profile ? S.resetProfileLabel : S.resetChatLabel}
      description={project ? S.resetProjectDescription : profile ? S.resetProfileDescription : S.resetChatDescription}
      meta={locked ? S.inUse : empty ? S.nothingToReset : undefined}
      trailing={<Button size="sm" variant="outline" label={S.reset} loading={running} disabled={running || locked || !ready || empty} onPress={() => setOpen(true)} />} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} description={body} cancelLabel={M.settings.cancel}
      action={<Button variant="destructive" label={S.reset} disabled={ops.sharedBusy || !ready || empty} onPress={() => { setOpen(false); void ops.start(kind); }} />}>
      {project ? <ListRow title={S.project} description={data.projects?.find(p => p.id === data.selected)?.display_name ?? S.project} /> : null}
      <ListRow title={S.removed} description={removed} /><ListRow title={S.kept} description={kept} />
      <Text variant="caption">{S.resetNote}</Text>
    </Sheet>
  </>;
}

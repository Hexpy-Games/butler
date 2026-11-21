import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { Button, ListRow, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { GroupInset, LoadState, SettingsGroup } from "../layout";
import { ReasoningRow, SelectRow, TimeRow } from "../rows";
import { useSettings } from "../useSettings";
import { modelLabel, runtimeModels, useModelCatalog } from "../useModelCatalog";
import type { useMemoryData } from "./useMemoryData";
import type { useMemoryOps } from "./useMemoryOps";
import { formatConsolidationTime } from "./memoryFormat";

export function ConsolidationGroup({ data, ops }: { data: ReturnType<typeof useMemoryData>; ops: ReturnType<typeof useMemoryOps> }) {
  const locale = useAppLocale(), S = getAppCopy(locale).settings;
  const { settings, update } = useSettings(), { catalog, error, reload } = useModelCatalog();
  const models = catalog ? runtimeModels(catalog) : [];
  const active = models.find(m => m.model_ref === settings?.model) ?? models[0];
  const model = models.find(m => m.model_ref === settings?.consolidation_model) ?? active;
  const last = data.status?.last_run, failed = last?.status === "error";
  const when = last ? formatConsolidationTime(last.at, locale, S.memory) : "";
  const locked = ops.busy || Boolean(ops.resetKind) || ops.leaseBusy;
  return <SettingsGroup title={S.pageSections.memoryCleanup} description={S.pageSectionDescriptions.memoryCleanup}>
    <TimeRow title={S.fields.consolidationTime} description={S.descriptions.consolidationTime}
      value={settings?.consolidation_time ?? data.status?.time_of_day ?? "04:00"} onChange={consolidation_time => void update({ consolidation_time })} />
    {!data.status || data.errors.status ? <GroupInset><LoadState error={Boolean(data.errors.status)} onRetry={data.reload} /></GroupInset> : <>
      <ListRow title={S.memory.runNowLabel} description={S.memory.runNowDescription} meta={locked && !ops.consolidating ? S.memory.inUse : undefined}
        trailing={<Button label={ops.consolidating ? S.memory.running : S.memory.runNow} disabled={locked || ops.consolidating}
          loading={ops.consolidating} onPress={() => void ops.start("consolidation")} />} />
      <GroupInset><Text variant="caption" tone={failed ? "danger" : "secondary"}>{last ? failed ? S.memory.lastRunFailed(when) : S.memory.lastRun(when) : S.memory.neverRun}</Text></GroupInset>
    </>}
    {!catalog ? <GroupInset><LoadState error={error} onRetry={reload} /></GroupInset> : <>
      <SelectRow title={S.fields.consolidationModel} description={S.descriptions.consolidationModel} value={settings?.consolidation_model ?? "default"}
        options={[{ value: "default", label: S.options.consolidationModelDefault, description: S.descriptions.consolidationModelDefault },
          ...models.map(m => ({ value: m.model_ref, label: modelLabel(m, locale) }))]} onSelect={consolidation_model => void update({ consolidation_model })} />
      <ReasoningRow title={S.fields.reasoning} model={model} value={settings?.consolidation_reasoning_effort ?? settings?.reasoning_effort ?? "none"}
        onSelect={consolidation_reasoning_effort => void update({ consolidation_reasoning_effort })} />
    </>}
  </SettingsGroup>;
}

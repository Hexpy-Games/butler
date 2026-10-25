import { AlertCircle, Button, IconSlot, Inline, SettingsActionField, SettingsField, Spinner, TimePicker, Tooltip, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { useButlerStore } from "@/app/store.ts";
import type { useConsolidation } from "./hooks/useConsolidation";
import { MemoryCleanupFields } from "./MemoryCleanupFields";
import { formatConsolidationTime } from "./consolidationTime";
import type { ConsolidationStatus } from "./memoryTypes";

export function ConsolidationFields({ operation, locked }: { operation: ReturnType<typeof useConsolidation>; locked: boolean }) {
  const locale = useAppLocale();
  const copy = appCopy.settings;
  const draft = useSettingsUIStore((state) => state.draft);
  const saving = useSettingsUIStore((state) => state.saving);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const busy = locked || operation.leaseBusy;
  return <>
    <SettingsField settingId="consolidation-time" label={copy.fields.consolidationTime} description={copy.descriptions.consolidationTime}
      control={<TimePicker value={draft?.consolidation_time ?? operation.status?.time_of_day ?? "04:00"} locale={locale}
        pickerLabel={copy.memory.pickTime} aria-label={copy.fields.consolidationTime} disabled={!draft || saving}
        onValueChange={(value) => { void update({ consolidation_time: value }, setSettings); }} />} />
    <SettingsActionField settingId="consolidation-run" label={copy.memory.runNowLabel}
      description={<>{copy.memory.runNowDescription}<br /><LastRun last={operation.status?.last_run} locale={locale} /></>}
      action={<ConsolidationRunButton running={operation.running} locked={busy} ready={Boolean(operation.status)} start={() => { void operation.start(); }} />} />
    <MemoryCleanupFields />
  </>;
}

function LastRun({ last, locale }: { last: ConsolidationStatus["last_run"] | undefined; locale: string }) {
  const copy = appCopy.settings.memory;
  const failed = last?.status === "error";
  const when = last ? formatConsolidationTime(last.at, locale, copy) : "";
  const text = last ? failed ? copy.lastRunFailed(when) : copy.lastRun(when) : copy.neverRun;
  return <Typo.Caption as="span" tone={failed ? "danger" : "secondary"} role="status">
    <Inline as="span" cross="start" wrap={false}>
      {failed && <IconSlot size="sm" minHeight="line" aria-hidden="true"><AlertCircle size="sm" /></IconSlot>}
      {text}
    </Inline>
  </Typo.Caption>;
}

function ConsolidationRunButton({ running, locked, ready, start, "aria-describedby": describedBy }: {
  running: boolean; locked: boolean; ready: boolean; start: () => void; "aria-describedby"?: string;
}) {
  const copy = appCopy.settings.memory;
  const label = running ? copy.running : copy.runNow;
  const reason = locked && !running ? copy.inUse : undefined;
  return <Tooltip label={reason} side="right">
    <Button type="button" variant="outline" size="sm" disabled={running || locked || !ready} aria-describedby={describedBy}
      aria-label={reason ? `${label}. ${reason}` : label}
      aria-busy={running || undefined} iconStart={running ? <Spinner size={14} /> : undefined} onClick={start}>
      {label}
    </Button>
  </Tooltip>;
}

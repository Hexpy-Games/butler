import { useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogForm, NativeSelect, SettingsField, Switch,
} from "@/butler-ds";
import { LOG_PERIODS, periodSince, type LogPeriod } from "./logsApi";
import { exportLogs } from "./logsTransport";

/** 내보내기…: a period and whether to include stored bodies. */
export function LogExportDialog({ onClose }: { onClose: () => void }) {
  const copy = appCopy.settings.logs;
  const rangeId = useId();
  const bodiesId = useId();
  const [period, setPeriod] = useState<LogPeriod>("day");
  const [includeBodies, setIncludeBodies] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (await exportLogs({ since: periodSince(period), includeBodies })) {
        notifyStatus(copy.exported, { id: "logs-export", tone: "ok" });
      }
      onClose();
    } catch (error) {
      notifyError(error, copy.exportFailed, { id: "logs-export" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent closeLabel={appCopy.common.close} aria-describedby={undefined} data-test-class="logs-export-dialog">
        <DialogForm dialog title={copy.exportTitle} busy={busy} onSubmit={() => void submit()}
          footer={
            <ButtonContainer size="default" justify="end">
              <Button type="button" variant="outline" onClick={onClose}>{appCopy.common.cancel}</Button>
              <Button type="submit" disabled={busy}>{copy.exportAction}</Button>
            </ButtonContainer>
          }>
          <SettingsField id={rangeId} label={copy.exportRange} control={
            <NativeSelect id={rangeId} value={period} onChange={(event) => setPeriod(event.currentTarget.value as LogPeriod)}>
              {LOG_PERIODS.map((value) => <option key={value} value={value}>{copy.periods[value]}</option>)}
            </NativeSelect>
          } />
          <SettingsField id={bodiesId} label={copy.includeBodies}
            control={<Switch id={bodiesId} checked={includeBodies} onCheckedChange={setIncludeBodies} />} />
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

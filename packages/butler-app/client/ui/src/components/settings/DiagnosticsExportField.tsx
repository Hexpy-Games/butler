import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, SettingsField } from "@/butler-ds";
import { exportLogs } from "./logs/logsTransport";

/** 정보 › 진단: saves the logs without content (no bodies), for any user. */
export function DiagnosticsExportField() {
  const copy = appCopy.settings.logs;
  const [busy, setBusy] = useState(false);

  async function exportDiagnostics() {
    setBusy(true);
    try {
      if (await exportLogs({ includeBodies: false })) {
        notifyStatus(copy.exported, { id: "diagnostics-export", tone: "ok" });
      }
    } catch (error) {
      notifyError(error, copy.exportFailed, { id: "diagnostics-export" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsField
      settingId="diagnostics-export"
      label={copy.diagnosticsLabel}
      description={copy.diagnosticsDescription}
      control={
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void exportDiagnostics()}>
          {copy.diagnosticsExport}
        </Button>
      }
    />
  );
}

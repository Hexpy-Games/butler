import type { ReactNode } from "react";
import { BUTLER_PLANS_URL, type ButlerBackupStatus } from "@/app/butlerBackup";
import { appCopy, getAppLocale } from "@/app/copy";
import { openExternalSignIn } from "@/app/openExternalSignIn";
import { Button, ButtonContainer, OverflowActionMenu, ProgressMeter, SettingsField, SettingsSection, Tooltip, Typo } from "@/butler-ds";
import { ButlerBackupKeyDialog } from "./ButlerBackupKeyDialog";
import { ButlerBackupRestoreDialog } from "./ButlerBackupRestoreDialog";
import { formatConsolidationTime } from "./consolidationTime";
import type { useButlerAccount } from "./hooks/useButlerAccount";
import type { useButlerBackup } from "./hooks/useButlerBackup";

type Backup = ReturnType<typeof useButlerBackup>;

export function butlerBackupSection({ backup, account }: {
  backup: Backup;
  account: ReturnType<typeof useButlerAccount>;
}) {
  if (!account.status?.signed_in) return null;
  const copy = appCopy.butlerBackup;
  const { status, busy, loadFailed } = backup;
  if (!status) return loadFailed ? (
    <SettingsSection id="butler-backup" title={copy.name} description={copy.description} kind="status"
      state="error" errorMessage={copy.failedToast} />
  ) : null;

  const { state, available } = status;
  const on = state === "idle" || state === "running" || state === "full" || state === "failed" || state === "paused";
  return (
    <SettingsSection id="butler-backup" title={copy.name}
      description={state === "off" && available ? undefined : copy.description} kind="status"
      actions={on ? <OverflowActionMenu label={copy.menu} items={[
        { label: copy.newKey, onSelect: () => void backup.newKey() },
        { label: copy.turnOff, onSelect: () => void backup.turnOff(), variant: "destructive" },
      ]} /> : undefined}>
      {on ? onContent(status, backup) : otherContent(status, backup)}
      {backup.recoveryKey && <ButlerBackupKeyDialog recoveryKey={backup.recoveryKey} busy={busy}
        onCancel={() => void backup.cancel()} onStart={() => void backup.start()} />}
      {backup.restoreOpen && <ButlerBackupRestoreDialog busy={busy} onCancel={() => backup.setRestoreOpen(false)} onRestore={backup.restore} />}
    </SettingsSection>
  );
}

function size(bytes: number) {
  return new Intl.NumberFormat(getAppLocale(), { maximumFractionDigits: 1 }).format(bytes / 1_000_000_000) + " GB";
}

function percentOf(done: number, total: number) {
  return total ? Math.min(100, Math.floor(100 * done / total)) : 0;
}

function onContent(status: ButlerBackupStatus, backup: Backup): ReactNode {
  const copy = appCopy.butlerBackup;
  const { state } = status;
  const full = state === "full";
  const failed = state === "failed";
  const message = state === "running" ? copy.running(percentOf(status.progress.done, status.progress.total))
    : full ? copy.full : failed ? copy.failed : state === "paused" ? copy.paused : undefined;
  const tooltip = state === "running" ? copy.runningTooltip : full ? copy.fullTooltip : state === "paused" ? copy.pausedTooltip : undefined;
  const run = <Button size="sm" disabled={backup.busy || Boolean(tooltip)}
    onClick={() => void backup.backUpNow()}>{failed ? copy.retry : copy.backUpNow}</Button>;
  const plansUrl = BUTLER_PLANS_URL;
  return <>
    <SettingsField label={copy.lastBackup} control={<Typo.Body>{status.last_backup_at
      ? formatConsolidationTime(status.last_backup_at, getAppLocale(), appCopy.settings.memory) : "—"}</Typo.Body>}
      afterControl={message && <Typo.Caption role="status" tone={full || failed ? "danger" : "secondary"}>{message}</Typo.Caption>} />
    {state === "running" && <ProgressMeter bare ariaLabel={message} value={percentOf(status.progress.done, status.progress.total)} />}
    <ProgressMeter label={copy.storage} ariaLabel={copy.storage} value={percentOf(status.used_bytes, status.quota_bytes)}
      meta={copy.usage(size(status.used_bytes), size(status.quota_bytes))} tone={full ? "danger" : "default"} />
    <ButtonContainer size="sm" justify="end">
      {full && <Button size="sm" variant="outline" disabled={!plansUrl}
        onClick={() => { if (plansUrl) openExternalSignIn(plansUrl); }}>{copy.viewPlans}</Button>}
      {tooltip ? <Tooltip label={tooltip}>{run}</Tooltip> : run}
    </ButtonContainer>
  </>;
}

function otherContent(status: ButlerBackupStatus, backup: Backup): ReactNode {
  const copy = appCopy.butlerBackup;
  const { state, restore, progress } = status;
  if (state === "restore_available" && restore) return <>
    <SettingsField label={copy.found} control={null} description={copy.foundMeta(
      new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "medium" }).format(new Date(restore.created_at)), size(restore.total_bytes))} />
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" onClick={() => backup.setRestoreOpen(true)}>{copy.restore}</Button>
    </ButtonContainer>
  </>;
  if (state === "restoring") return <ProgressMeter label={copy.restoring} ariaLabel={copy.restoring}
    value={percentOf(progress.done, progress.total)} meta={copy.usage(size(progress.done), size(progress.total))} />;
  if (state === "restore_ready") return <SettingsField label={copy.restartToFinish} control={
    <Button size="sm" disabled={backup.busy} onClick={() => void backup.restart()}>{copy.restart}</Button>} />;
  const turnOn = <Button size="sm" disabled={!status.available || backup.busy} onClick={() => void backup.createKey()}>{copy.turnOn}</Button>;
  return <>
    {status.available && <Typo.Caption tone="secondary">{copy.description}</Typo.Caption>}
    <ButtonContainer size="sm" justify="end">
      {status.available ? turnOn : <Tooltip label={copy.plusOnly}>{turnOn}</Tooltip>}
    </ButtonContainer>
  </>;
}

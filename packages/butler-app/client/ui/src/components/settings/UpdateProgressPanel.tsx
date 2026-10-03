import { appCopy } from "@/app/copy";
import type { UpdateProgressView } from "@/app/types";
import { Button, ButtonContainer, ProgressMeter, Spinner, Stack, Typo } from "@/butler-ds";

export function UpdateProgressPanel({ progress, onCancel }: {
  progress: UpdateProgressView; onCancel?: () => void;
}) {
  const copy = appCopy.settings.updateProgress;
  const label = copy[progress.stage];
  const known = progress.stage === "downloading" && progress.bytes_total !== null && progress.bytes_total > 0;
  const bytes = progress.bytes_done;
  return (
    <Stack gap="xs" role="status" aria-live="polite" data-test-id="update-progress" data-stage={progress.stage}>
      {known ? <ProgressMeter label={label} ariaLabel={label}
        value={Math.min(100, (bytes ?? 0) / progress.bytes_total! * 100)}
        meta={`${Math.floor((bytes ?? 0) / progress.bytes_total! * 100)}% · ${formatBytes(bytes ?? 0)} / ${formatBytes(progress.bytes_total!)}`} /> : (
        <Stack align="row" cross="center" gap="sm">
          {!["idle", "failed", "completed", "ready"].includes(progress.stage) && <Spinner />}
          <Typo.Caption>{label}</Typo.Caption>
        </Stack>
      )}
      {progress.stage === "downloading" && !known && <Typo.Caption>
        {bytes !== null ? `${formatBytes(bytes)} · ` : ""}{copy.bytesUnavailable}
      </Typo.Caption>}
      {progress.stage === "downloading" && progress.bytes_per_second != null && <Typo.Caption>{formatBytes(progress.bytes_per_second)}/s</Typo.Caption>}
      {progress.stage === "failed" && <Typo.Caption>{failureReason(progress.error_code)}</Typo.Caption>}
      {progress.cancellable && onCancel && <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
      </ButtonContainer>}
    </Stack>
  );
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function failureReason(code: string | null): string {
  const copy = appCopy.settings.updateProgress;
  if (code === "update_cancelled") return copy.cancelled;
  if (code === "update_artifact_sha256_mismatch") return copy.checksumFailed;
  if (code === "update_activation_failed") return copy.activationFailed;
  return copy.sourceFailed;
}

import { appCopy } from "@/app/copy";
import type { UpdateProgressView } from "@/app/types";
import { CircleAlert, Notice, ProgressMeter, Stack } from "@/butler-ds";
import { formatUpdateBytes, updateFailureMessage, updateProgressText } from "./updateProgressDisplay";

/** Download feedback and failures share the updater-owned snapshot. */
export function UpdateProgressPanel({ progress }: { progress: UpdateProgressView }) {
  const copy = appCopy.settings.updateProgress;
  if (!["downloading", "failed"].includes(progress.stage) || progress.error_code === "update_cancelled") return null;
  const total = progress.bytes_total;
  const known = total !== null && total > 0;
  const percent = known ? Math.min(100, Math.floor((progress.bytes_done ?? 0) / total * 100)) : 0;
  const done = formatUpdateBytes(progress.bytes_done ?? 0);
  return (
    <Stack gap="xs" role="status" aria-live="polite" data-test-id="update-progress" data-stage={progress.stage}>
      {progress.stage === "failed" ? <Notice tone="error" icon={<CircleAlert />} message={updateFailureMessage(progress.error_code)} />
        : <ProgressMeter label={copy.downloading} ariaLabel={copy.downloading} value={percent} indeterminate={!known}
          meta={known ? updateProgressText(copy.downloadMeta, { percent, done, total: formatUpdateBytes(total) })
            : progress.bytes_done !== null ? updateProgressText(copy.downloadedBytes, { done }) : undefined} />}
    </Stack>
  );
}

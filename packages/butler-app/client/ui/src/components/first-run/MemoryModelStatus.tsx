import { AlertCircle, Button, IconSlot, Inline, Spinner, Stack, Typo } from "@/butler-ds";
import { appLocaleFromLanguage, getAppCopy } from "@/app/copy.ts";
import type { MemoryModelProgress } from "@/app/setupReadiness.ts";

/** Optional memory preparation; never changes setup eligibility. */
export function MemoryModelStatus({ model, language, retry }: {
  model?: MemoryModelProgress; language: string; retry: () => void;
}) {
  if (!model || model.state === "ready") return null;
  const copy = getAppCopy(appLocaleFromLanguage(language)).firstRun.memoryModel;
  const failed = model.state === "failed";
  const label = failed ? copy.failed : model.state === "verifying" ? copy.verifying : copy.downloading;
  const percent = model.bytes_total > 0 ? Math.floor(model.bytes_done / model.bytes_total * 100) : 0;
  const progress = copy.progress(percent, Math.round(model.bytes_done / 1_000_000), Math.round(model.bytes_total / 1_000_000));
  return (
    <Typo.Caption as="div" tone={failed ? "danger" : "secondary"} role="status" data-test-class="memory-model-status">
      <Inline cross="start" wrap={false}>
        <IconSlot size="sm" minHeight="line" aria-hidden="true">
          {failed ? <AlertCircle size="sm" /> : <Spinner size={14} />}
        </IconSlot>
        <Inline grow minWidth="0" cross="start">
          <Stack as="span" gap="xs" basis="content" minWidth="0">
            <Typo.Caption as="span" tone={failed ? "danger" : "secondary"} numeric="tabular">
              {model.state === "downloading" ? `${label} · ${progress}` : label}
            </Typo.Caption>
            {failed ? <Typo.Caption as="span" tone="secondary">{copy.reasons[model.reason ?? ""] ?? copy.reasons.default}</Typo.Caption> : null}
          </Stack>
          {failed ? <Button size="xs" variant="inline" onClick={retry}>{copy.retry}</Button> : null}
        </Inline>
      </Inline>
    </Typo.Caption>
  );
}

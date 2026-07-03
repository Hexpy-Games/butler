import type { DeveloperLogEntryView } from "@/app/types.ts";
import { Grid, KeyValueRow, Stack } from "@/butler-ds";
import { formatJson } from "./developerLogFormat";
import { RawBlock } from "./DeveloperLogRawBlock";
import type { DeveloperLogViewerCopy } from "./developerLogViewerTypes";

export function MetadataPanel({
  entry,
  copy,
}: {
  entry: DeveloperLogEntryView;
  copy: DeveloperLogViewerCopy;
}) {
  return (
    <Stack gap="md">
      <Grid gap="sm">
        <KeyValueRow label={copy.labels.provider} value={entry.model.provider_id ?? "-"} />
        <KeyValueRow label={copy.labels.runtime} value={entry.model.runtime_adapter_id ?? "-"} />
        <KeyValueRow label={copy.labels.routeReason} value={entry.route.reason ?? "-"} />
        <KeyValueRow label={copy.labels.project} value={entry.route.project_id ?? "-"} />
        <KeyValueRow
          label={copy.labels.rawText}
          value={entry.privacy.raw_text_included ? copy.labels.included : copy.labels.excluded}
        />
        <KeyValueRow
          label={copy.labels.secrets}
          value={entry.privacy.secrets_redacted ? copy.labels.redacted : copy.labels.notRedacted}
        />
      </Grid>
      <RawBlock title={copy.labels.route} value={formatJson(entry.route)} compact />
      <RawBlock title={copy.labels.references} value={formatJson(entry.context.references)} />
    </Stack>
  );
}

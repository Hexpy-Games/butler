import type { DeveloperLogEntryView } from "@/app/types.ts";
import { KeyValueRow, ScrollArea, Stack, Typo } from "@/butler-ds";
import { formatCount, formatJson } from "./developerLogFormat";
import type { DeveloperLogViewerCopy } from "./developerLogViewerTypes";
import styles from "./DeveloperLogsSettings.module.css";

export function ContextPanel({
  entry,
  copy,
}: {
  entry: DeveloperLogEntryView;
  copy: DeveloperLogViewerCopy;
}) {
  return (
    <Stack gap="md">
      <div className={styles.kvGrid}>
        <KeyValueRow label={copy.labels.liveConfig} value={entry.context.live_config_hash ?? "-"} />
        <KeyValueRow label={copy.labels.sectionCount} value={entry.context.sections.length} />
        <KeyValueRow label={copy.labels.references} value={entry.context.references.length} />
        <KeyValueRow label={copy.labels.promptChars} value={formatCount(entry.context.prompt_context.length)} />
      </div>
      <div className={styles.sectionList}>
        {entry.context.sections.map((section) => (
          <div key={`${section.region}:${section.id}`} className={styles.sectionBlock}>
            <div className={styles.sectionHeader}>
              <Typo.Body as="div">{section.title}</Typo.Body>
              <Typo.Caption>
                {section.region} / {section.id} / {copy.labels.contextChars(formatCount(section.char_count))}
              </Typo.Caption>
            </div>
            <RawBlock title={section.title} value={section.content} compact hideTitle />
          </div>
        ))}
      </div>
      <RawBlock title={copy.labels.renderedPromptContext} value={entry.context.prompt_context} />
    </Stack>
  );
}

export function MetadataPanel({
  entry,
  copy,
}: {
  entry: DeveloperLogEntryView;
  copy: DeveloperLogViewerCopy;
}) {
  return (
    <Stack gap="md">
      <div className={styles.kvGrid}>
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
      </div>
      <RawBlock title={copy.labels.route} value={formatJson(entry.route)} compact />
      <RawBlock title={copy.labels.references} value={formatJson(entry.context.references)} />
    </Stack>
  );
}

export function RawBlock({
  title,
  value,
  compact = false,
  hideTitle = false,
}: {
  title: string;
  value: string;
  compact?: boolean;
  hideTitle?: boolean;
}) {
  return (
    <Stack gap="xs">
      {hideTitle ? null : <Typo.Caption>{title}</Typo.Caption>}
      <ScrollArea className={compact ? styles.compactScroll : styles.rawScroll}>
        <pre className={styles.pre}>{value || "-"}</pre>
      </ScrollArea>
    </Stack>
  );
}

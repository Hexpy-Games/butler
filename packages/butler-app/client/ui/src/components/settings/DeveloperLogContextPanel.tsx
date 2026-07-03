import type { DeveloperLogEntryView } from "@/app/types.ts";
import { Grid, KeyValueRow, Stack, SurfacePanel, Typo } from "@/butler-ds";
import { formatCount } from "./developerLogFormat";
import { RawBlock } from "./DeveloperLogRawBlock";
import type { DeveloperLogViewerCopy } from "./developerLogViewerTypes";

export function ContextPanel({
  entry,
  copy,
}: {
  entry: DeveloperLogEntryView;
  copy: DeveloperLogViewerCopy;
}) {
  return (
    <Stack gap="md">
      <Grid gap="sm">
        <KeyValueRow label={copy.labels.liveConfig} value={entry.context.live_config_hash ?? "-"} />
        <KeyValueRow label={copy.labels.sectionCount} value={entry.context.sections.length} />
        <KeyValueRow label={copy.labels.references} value={entry.context.references.length} />
        <KeyValueRow label={copy.labels.promptChars} value={formatCount(entry.context.prompt_context.length)} />
      </Grid>
      <Stack gap="sm">
        {entry.context.sections.map((section) => (
          <SurfacePanel key={`${section.region}:${section.id}`} elevation="none">
            <Stack gap="sm">
              <Stack align="row" justify="between" gap="sm" wrap>
                <Typo.Body as="div">{section.title}</Typo.Body>
                <Typo.Caption>
                  {section.region} / {section.id} / {copy.labels.contextChars(formatCount(section.char_count))}
                </Typo.Caption>
              </Stack>
              <RawBlock title={section.title} value={section.content} compact hideTitle />
            </Stack>
          </SurfacePanel>
        ))}
      </Stack>
      <RawBlock title={copy.labels.renderedPromptContext} value={entry.context.prompt_context} />
    </Stack>
  );
}

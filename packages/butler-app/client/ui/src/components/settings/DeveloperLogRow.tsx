import type { DeveloperLogEntryView } from "@/app/types.ts";
import {
  DisclosureRow,
  SurfacePanel,
  Stack,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Typo,
} from "@/butler-ds";
import { formatCount, formatJson, formatTimestamp } from "./developerLogFormat";
import { ContextPanel } from "./DeveloperLogContextPanel";
import { MetadataPanel } from "./DeveloperLogMetadataPanel";
import { RawBlock } from "./DeveloperLogRawBlock";
import type {
  DeveloperLogTab,
  DeveloperLogViewerCopy,
} from "./developerLogViewerTypes";

export function DeveloperLogRow({
  entry,
  open,
  tab,
  copy,
  onTabChange,
  onToggle,
}: {
  entry: DeveloperLogEntryView;
  open: boolean;
  tab: DeveloperLogTab;
  copy: DeveloperLogViewerCopy;
  onTabChange: (tab: DeveloperLogTab) => void;
  onToggle: () => void;
}) {
  const promptChars = entry.context.prompt_context.length;
  const responseChars = entry.response.text.length;
  return (
    <DisclosureRow
      controlsId={`developer-log-${entry.id}`}
      description={<DeveloperLogRowDescription entry={entry} copy={copy} />}
      meta={
        <Typo.Caption as="span">
          {copy.labels.sections(entry.context.sections.length)}
          {" / "}
          {copy.labels.contextChars(formatCount(promptChars))}
          {" / "}
          {copy.labels.responseChars(formatCount(responseChars))}
        </Typo.Caption>
      }
      open={open}
      title={entry.model.requested_model_ref}
      onToggle={onToggle}
    >
      <SurfacePanel elevation="none">
          <Tabs value={tab} onValueChange={(value) => onTabChange(value as DeveloperLogTab)}>
            <TabsList variant="line">
              <TabsTrigger value="context">{copy.tabs.context}</TabsTrigger>
              <TabsTrigger value="request">{copy.tabs.request}</TabsTrigger>
              <TabsTrigger value="response">{copy.tabs.response}</TabsTrigger>
              <TabsTrigger value="metadata">{copy.tabs.metadata}</TabsTrigger>
            </TabsList>
            <TabsContent value="context">
              <ContextPanel entry={entry} copy={copy} />
            </TabsContent>
            <TabsContent value="request">
              <RawBlock title={copy.labels.input} value={entry.request.input_text} compact />
              <RawBlock title={copy.tabs.metadata} value={formatJson(entry.request.metadata)} />
            </TabsContent>
            <TabsContent value="response">
              <RawBlock title={copy.labels.text} value={entry.response.text} compact />
              <RawBlock title={copy.labels.raw} value={formatJson(entry.response.raw)} />
            </TabsContent>
            <TabsContent value="metadata">
              <MetadataPanel entry={entry} copy={copy} />
            </TabsContent>
          </Tabs>
      </SurfacePanel>
    </DisclosureRow>
  );
}

function DeveloperLogRowDescription({
  entry,
  copy,
}: {
  entry: DeveloperLogEntryView;
  copy: DeveloperLogViewerCopy;
}) {
  return (
    <Stack gap="xs">
      <Stack align="row" gap="xs" wrap>
        <Tag>{entry.kind}</Tag>
        <Tag>{entry.transport}</Tag>
        {entry.route.reason && <Tag>{entry.route.reason}</Tag>}
        <Tag>
          {copy.labels.secrets}: {entry.privacy.secrets_redacted ? copy.labels.redacted : copy.labels.included}
        </Tag>
        <Tag>
          {copy.labels.rawText}: {entry.privacy.raw_text_included ? copy.labels.included : copy.labels.excluded}
        </Tag>
      </Stack>
      <Stack align="row" gap="xs" wrap>
        <Typo.Caption>{formatTimestamp(entry.created_at)}</Typo.Caption>
        <Typo.Caption>{entry.session_id}</Typo.Caption>
        {entry.turn_id && <Typo.Caption>{entry.turn_id}</Typo.Caption>}
      </Stack>
    </Stack>
  );
}

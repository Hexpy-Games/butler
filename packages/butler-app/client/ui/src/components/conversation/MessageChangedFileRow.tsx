import { useAppLocale } from "@/app/copy.ts";
import { memo, useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { ChangedFileDetail, MessageFileRef } from "@/app/types.ts";
import { ChangedLineDiff, DisclosureRow, FileText, Inline, ListRow, Stack } from "@/butler-ds";
import { WorkingFileMenu } from "./WorkingFileMenu";

function MessageChangedFileRowComponent({ file, stored }: { file: ChangedFileDetail; stored?: MessageFileRef }) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const hasLines = file.lines.length > 0;
  const meta = hasLines
    ? appCopy.conversation.fileChanges.fileCounts(file.additions, file.deletions)
    : appCopy.conversation.fileChanges.noLineDetails;

  const row = !hasLines ? <ListRow icon={<FileText size="lg" />} meta={meta} title={file.path} /> : (
    <DisclosureRow
      controlsId={detailsId}
      icon={<FileText size="lg" />}
      meta={meta}
      open={expanded}
      surface="plain"
      title={file.path}
      onToggle={() => setExpanded((value) => !value)}
    >
      <ChangedLineDiff
        ariaLabel={appCopy.conversation.fileChanges.diffRegionLabel(file.path)}
        id={detailsId}
        lines={file.lines}
      />
    </DisclosureRow>
  );
  if (!stored) return row;
  // The ⋯ stays at the row header while the diff opens below it.
  return (
    <Inline gap="xs" wrap={false} cross={expanded ? "start" : "center"}>
      <Stack.Item grow minWidth="0">{row}</Stack.Item>
      <WorkingFileMenu file={stored} title={file.path} />
    </Inline>
  );
}

export const MessageChangedFileRow = memo(MessageChangedFileRowComponent);

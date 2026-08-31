import { memo, useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { ChangedFileDetail } from "@/app/types.ts";
import { ChangedLineDiff, DisclosureRow, FileText, ListRow } from "@/butler-ds";

function MessageChangedFileRowComponent({ file }: { file: ChangedFileDetail }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const hasLines = file.lines.length > 0;
  const meta = hasLines
    ? appCopy.conversation.fileChanges.fileCounts(file.additions, file.deletions)
    : appCopy.conversation.fileChanges.noLineDetails;

  if (!hasLines) {
    return <ListRow icon={<FileText size={20} />} meta={meta} title={file.path} />;
  }
  return (
    <DisclosureRow
      controlsId={detailsId}
      icon={<FileText size={20} />}
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
}

export const MessageChangedFileRow = memo(MessageChangedFileRowComponent);

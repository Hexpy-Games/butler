import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { FileText, Inline, ListRow, Stack } from "@/butler-ds";
import { formatArtifactSize } from "@/components/artifacts/artifactDisplay";
import { WorkingFileMenu } from "./WorkingFileMenu";

/** A file the turn made that has no line diff: the block's no-diff row shape plus its ⋯. */
export function MessageGeneratedFileRow({ file }: { file: MessageFileRef }) {
  useAppLocale();
  const title = file.source_label ?? file.safe_name;
  return (
    <Inline gap="xs" wrap={false}>
      <Stack.Item grow minWidth="0">
        <ListRow icon={<FileText size="lg" />} meta={appCopy.conversation.fileChanges.newFile(formatArtifactSize(file.size_bytes))} title={title} />
      </Stack.Item>
      <WorkingFileMenu file={file} title={title} />
    </Inline>
  );
}

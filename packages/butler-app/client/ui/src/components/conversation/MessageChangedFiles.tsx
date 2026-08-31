import { appCopy } from "@/app/copy.ts";
import type { ChangedFileDetail } from "@/app/types.ts";
import { Space, Stack, Typo } from "@/butler-ds";
import { MessageChangedFileRow } from "./MessageChangedFileRow.tsx";

export function MessageChangedFiles({ files }: { files: ChangedFileDetail[] }) {
  if (files.length === 0) return null;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return (
    <>
      <Space size="md" />
      <Stack
        aria-label={appCopy.conversation.fileChanges.regionLabel}
        data-test-class="message-changed-file-list"
        gap="xs"
        role="region"
      >
        <Typo.Label>
          {appCopy.conversation.fileChanges.titleSummary(
            files.length,
            additions,
            deletions,
          )}
        </Typo.Label>
        {files.map((file) => (
          <MessageChangedFileRow key={file.path} file={file} />
        ))}
      </Stack>
    </>
  );
}

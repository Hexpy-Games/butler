import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { ChangedFileDetail } from "@/app/types.ts";
import { Button, Space, Stack, Typo } from "@/butler-ds";
import { MessageChangedFileRow } from "./MessageChangedFileRow.tsx";

const INITIAL_VISIBLE_FILES = 5;

export function MessageChangedFiles({ files }: { files: ChangedFileDetail[] }) {
  const [expanded, setExpanded] = useState(false);
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
        {(expanded ? files : files.slice(0, INITIAL_VISIBLE_FILES)).map((file) => (
          <MessageChangedFileRow key={file.path} file={file} />
        ))}
        {files.length > INITIAL_VISIBLE_FILES ? (
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-changed-files"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? appCopy.conversation.fileChanges.showLess
              : appCopy.conversation.fileChanges.showMore(files.length - INITIAL_VISIBLE_FILES)}
          </Button>
        ) : null}
      </Stack>
    </>
  );
}

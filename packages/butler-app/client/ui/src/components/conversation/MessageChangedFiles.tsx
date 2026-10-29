import { useAppLocale } from "@/app/copy.ts";
import { useMemo, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { ChangedFileDetail, MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import { Button, Space, Stack, Typo } from "@/butler-ds";
import { inlineImageFiles } from "./inlineImageFiles";
import { MessageChangedFileRow } from "./MessageChangedFileRow.tsx";
import { MessageGeneratedFileRow } from "./MessageGeneratedFileRow";
import { workingFileRows } from "./workingFiles";

const INITIAL_VISIBLE_FILES = 5;

export function MessageChangedFiles({ files, attachments = [], artifacts = [], text = "", bubble = false }: {
  bubble?: boolean;
  files: ChangedFileDetail[];
  attachments?: MessageFileRef[];
  artifacts?: SessionArtifactSummary[];
  text?: string;
}) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(
    () => workingFileRows(files, attachments, () => inlineImageFiles(text, attachments, artifacts)),
    [files, attachments, artifacts, text],
  );
  if (rows.length === 0) return null;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return (
    <>
      {!bubble && <Space size="md" />}
      <Stack
        aria-label={appCopy.conversation.fileChanges.regionLabel}
        data-test-class="message-changed-file-list"
        gap="xs"
        role="region"
      >
        <Typo.Label>
          {appCopy.conversation.fileChanges.titleSummary(
            rows.length,
            additions,
            deletions,
          )}
        </Typo.Label>
        {(expanded ? rows : rows.slice(0, INITIAL_VISIBLE_FILES)).map((row) => row.change
          ? <MessageChangedFileRow key={row.key} file={row.change} stored={row.file} />
          : row.file ? <MessageGeneratedFileRow key={row.key} file={row.file} /> : null)}
        {rows.length > INITIAL_VISIBLE_FILES ? (
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-changed-files"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? appCopy.conversation.fileChanges.showLess
              : appCopy.conversation.fileChanges.showMore(rows.length - INITIAL_VISIBLE_FILES)}
          </Button>
        ) : null}
      </Stack>
    </>
  );
}

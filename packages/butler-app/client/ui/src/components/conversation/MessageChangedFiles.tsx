import { appCopy } from "@/app/copy.ts";
import { ArtifactList, FileText, Space, Stack, Typo } from "@/butler-ds";

export function MessageChangedFiles({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <>
      <Space size="md" />
      <Stack
        aria-label={appCopy.conversation.fileChanges.regionLabel}
        data-test-class="message-changed-file-list"
        gap="xs"
        role="region"
      >
        <Typo.Label>{appCopy.conversation.fileChanges.title}</Typo.Label>
        <ArtifactList
          items={paths.map((path) => ({
            id: path,
            title: path,
            icon: <FileText size={20} />,
          }))}
        />
      </Stack>
    </>
  );
}

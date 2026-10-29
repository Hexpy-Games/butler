import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton, Library, MoreHorizontal, Popup, Save } from "@/butler-ds";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import { addWorkingFileToLibrary } from "./workingFileActions";
import { fileArtifact } from "./workingFiles";

/** ⋯ beside a changed-files row that has a stored copy: open, save, save to the Library. */
export function WorkingFileMenu({ file, title }: { file: MessageFileRef; title: string }) {
  useAppLocale();
  const openArtifact = useButlerStore((state) => state.openArtifact);
  const artifact = fileArtifact(file);
  const save = artifactCardActions(artifact)[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`${appCopy.browser.more}: ${title}`} data-test-class="working-file-menu"><MoreHorizontal size="sm" /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openArtifact(artifact)}><Popup size="sm" />{appCopy.artifacts.open}</DropdownMenuItem>
        {save && (
          <DropdownMenuItem onSelect={() => save.href ? download(save.href, save.download) : save.onClick?.()}><Save size="sm" />{save.label}</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void addWorkingFileToLibrary(file.file_id)}>
          <Library size="sm" />{appCopy.conversation.answerBlocks.saveToLibrary}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The browser save of the card's download link (a menu item is not a link). */
function download(href: string, name?: string) {
  const link = document.createElement("a");
  link.href = href;
  if (name) link.download = name;
  link.click();
}

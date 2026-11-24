import { useState } from "react";
import { canSelectProjectFolder, selectProjectFolder } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, CardList, CardListItem, EmptyLine, Folder, IconButton, Input, Stack, Trash2 } from "@/butler-ds";
import type { useAllowedFolders } from "./useAllowedFolders";

export function AllowedFoldersSection({ settings }: { settings: ReturnType<typeof useAllowedFolders> }) {
  const copy = appCopy.settings.allowedFolders;
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const disabled = settings.busy || picking;
  async function pickFolder() {
    setPicking(true);
    try {
      const result = await selectProjectFolder();
      if (result.cancelled) return;
      if (result.folder_path) await settings.add(result.folder_path);
      else notifyStatus(copy.refused, { tone: "error" });
    } catch {
      notifyStatus(copy.refused, { tone: "error" });
    } finally { setPicking(false); }
  }
  return <Stack gap="sm">
    <CardList empty={<EmptyLine message={copy.empty} />}>
      {settings.folders.map(folder => <CardListItem key={folder.rule_id} icon={<Folder />} title={folder.path}
        actions={<IconButton label={copy.remove} disabled={disabled} onClick={() => void settings.remove(folder.rule_id)}>
          <Trash2 size="sm" />
        </IconButton>} />)}
    </CardList>
    <ButtonContainer size="sm">
      {canSelectProjectFolder()
        ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void pickFolder()}>{copy.add}</Button>
        : <>
          <Input aria-label={copy.add} value={path} disabled={disabled}
            onChange={event => setPath(event.currentTarget.value)} />
          <Button size="sm" variant="secondary" disabled={disabled || !path.trim()} onClick={async () => {
            if (await settings.add(path)) setPath("");
          }}>{copy.add}</Button>
        </>}
    </ButtonContainer>
  </Stack>;
}

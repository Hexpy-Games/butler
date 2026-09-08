import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import {
  Button,
  ButtonContainer,
  Stack,
  SurfacePanel,
  Typo,
} from "@/butler-ds";
import { archiveSubtitle, type ArchiveItem } from "./archiveSettingsUtils";

export function ArchiveItemRow({
  item,
  busy,
  onRestore,
  onRemove,
}: {
  item: ArchiveItem;
  busy: boolean;
  onRestore: () => void;
  onRemove: () => void;
}) {
  useAppLocale();
  return (
    <SurfacePanel elevation="none">
      <Stack align="row" cross="center" gap="md" justify="between" wrap>
        <Stack gap="xs">
          <Typo.Body as="div">{item.title}</Typo.Body>
          <Typo.Caption>
            {archiveSubtitle(item)} · {relativeAge(item.updatedAt)}
          </Typo.Caption>
        </Stack>
        <ButtonContainer size="sm">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onRestore}
          >
            {appCopy.interfaceDetails.unarchive}</Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onRemove}
          >
            {appCopy.interfaceDetails.delete}</Button>
        </ButtonContainer>
      </Stack>
    </SurfacePanel>
  );
}

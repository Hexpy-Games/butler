import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import {
  Button,
  ButtonContainer,
  Stack,
  Typo,
} from "@/butler-ds";
import { archiveSubtitle, type ArchiveItem } from "./archiveSettingsUtils";

export function ArchiveItemRow({
  item,
  busy,
  onOpen,
  onRestore,
  onRemove,
}: {
  item: ArchiveItem;
  busy: boolean;
  onOpen?: () => void;
  onRestore: () => void;
  onRemove: () => void;
}) {
  useAppLocale();
  return (
      <Stack align="row" cross="center" gap="md" justify="between" wrap>
        <Stack gap="xs">
          <Typo.Body as="div">{onOpen ? <Button size="sm" variant="link" onClick={onOpen}>{item.title}</Button> : item.title}</Typo.Body>
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
  );
}

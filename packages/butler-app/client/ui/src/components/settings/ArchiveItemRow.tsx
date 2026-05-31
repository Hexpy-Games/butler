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
            아카이브 취소
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onRemove}
          >
            삭제
          </Button>
        </ButtonContainer>
      </Stack>
    </SurfacePanel>
  );
}

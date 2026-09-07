import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  Stack,
  Typo,
} from "@/butler-ds";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";
import { SpaceRow } from "./SpaceRow";
import { SpaceGroupForm } from "./SpaceGroupForm";
import { SpaceMoveForm } from "./SpaceMoveForm";
import { SpaceRelocationForm } from "./SpaceRelocationForm";
export function SpaceDialogs({ rows }: { rows: Map<string, SpaceRowData> }) {
  const dialog = useOrganization((s) => s.dialog);
  const error = useOrganization((s) => s.error);
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open) useOrganization.getState().setDialog(null);
      }}
    >
      <DialogContent>
        {dialog?.kind === "create" || dialog?.kind === "rename" ? (
          <SpaceGroupForm key={JSON.stringify(dialog)} dialog={dialog} />
        ) : dialog?.kind === "move" ? (
          <SpaceMoveForm
            key={dialog.sourceKey}
            sourceKey={dialog.sourceKey}
            rows={rows}
          />
        ) : dialog?.kind === "relocate" ? (
          <SpaceRelocationForm dialog={dialog} rows={rows} />
        ) : dialog?.kind === "favorites" ? (
          <Stack gap="4">
            <DialogHeader>
              <DialogTitle>즐겨찾기</DialogTitle>
              <DialogDescription>
                고정한 대화와 프로젝트입니다.
              </DialogDescription>
            </DialogHeader>
            <ScrollArea>
              {[...rows.values()]
                .filter((r) => r.pinned)
                .map((row) => (
                  <SpaceRow key={row.node.key} rowKey={row.node.key} shortcut />
                ))}
            </ScrollArea>
          </Stack>
        ) : null}
        {error && <Typo.Body role="alert">{error}</Typo.Body>}
      </DialogContent>
    </Dialog>
  );
}

import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, ListRow, Monitor, Stack, Tooltip } from "@/butler-ds";
import type { Computer } from "./computersApi";
import type { ComputerStatus } from "./hooks/useComputers";

export function ComputerRow({ computer, status, busy, onEdit, onRemove }: {
  computer: Computer;
  status: ComputerStatus;
  busy: boolean;
  onEdit(): void;
  onRemove(): void;
}) {
  const copy = appCopy.computers;
  const working = appCopy.settings.security.working;
  const removeLabel = copy.removeComputer(computer.name);
  const remove = (
    <Tooltip label={busy ? working : removeLabel}>
      <Button size="sm" variant="outline" disabled={busy} aria-label={removeLabel} onClick={onRemove}>{copy.remove}</Button>
    </Tooltip>
  );
  const row = (
    <Stack align="row" cross="center" gap="sm" wrap data-test-class="computer-row">
      <Stack grow minWidth="0">
        <ListRow icon={<Monitor size="md" />} title={computer.name} description={computer.address} meta={copy.status[status]} />
      </Stack>
      <ButtonContainer size="sm">
        <Tooltip label={busy ? working : undefined}>
          <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>{copy.edit}</Button>
        </Tooltip>
        {remove}
      </ButtonContainer>
    </Stack>
  );
  return status === "stopsOnLogout" ? <Tooltip label={copy.stopsOnLogoutHint} wrap>{row}</Tooltip> : row;
}

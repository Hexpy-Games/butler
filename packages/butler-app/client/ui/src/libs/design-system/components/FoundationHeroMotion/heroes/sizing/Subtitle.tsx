import { IconSlot } from "../../../IconSlot";
import { GitBranch } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import type { SizingCopy } from "./sizingCopy";

/** The product's titlebar subtitle: the project, then the local workspace with its branch glyph. */
export function Subtitle({ copy }: { copy: SizingCopy }) {
  return (
    <Stack align="row" as="span" cross="center" gap="sm" inline minWidth="0">
      <Typo.Text minWidth="0" truncate>{copy.project}</Typo.Text>
      <Stack align="row" as="span" cross="center" gap="xs" inline minWidth="0">
        <IconSlot size="xs" tone="secondary"><GitBranch aria-hidden="true" size="xs" /></IconSlot>
        <Typo.Text tone="secondary" truncate>{copy.local}</Typo.Text>
      </Stack>
    </Stack>
  );
}

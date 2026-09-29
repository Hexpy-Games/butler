import { Box } from "../../../Box";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { type RadiusCopy } from "./radiusCopy";

/** A card at the panel radius (10). */
export function ReportCard({ copy }: { copy: RadiusCopy }) {
  return (
    <Box border="hairline" padding="md" radius="panel" surface="raised">
      <Stack gap="xs">
        <Typo.Label as="span">{copy.panelTitle}</Typo.Label>
        <Typo.Caption>{copy.panelBody}</Typo.Caption>
      </Stack>
    </Box>
  );
}

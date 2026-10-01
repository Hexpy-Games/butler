import { Box } from "../../../Box";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";

export const cardBody = (title: string, body: string) => (
  <Box border="hairline" padding="md" radius="panel" surface="raised">
    <Stack gap="xs"><Typo.Label as="span">{title}</Typo.Label><Typo.Caption>{body}</Typo.Caption></Stack>
  </Box>
);

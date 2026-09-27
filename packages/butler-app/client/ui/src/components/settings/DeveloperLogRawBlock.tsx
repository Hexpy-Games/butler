import { Box, ScrollArea, Stack, Typo } from "@/butler-ds";

export function RawBlock({
  title,
  value,
  compact = false,
  hideTitle = false,
}: {
  title: string;
  value: string;
  compact?: boolean;
  hideTitle?: boolean;
}) {
  return (
    <Stack gap="xs">
      {hideTitle ? null : <Typo.Caption>{title}</Typo.Caption>}
      <ScrollArea maxHeight={compact ? "xs" : "sm"}>
        <Box padding="md">
          <Typo.Code as="pre" tone="primary" wrap="pre">{value || "-"}</Typo.Code>
        </Box>
      </ScrollArea>
    </Stack>
  );
}

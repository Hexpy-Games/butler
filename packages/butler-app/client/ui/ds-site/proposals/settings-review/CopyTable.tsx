import { Box, Separator, Stack, Tag, Typo } from "@/butler-ds";
import type { CopyEntry } from "./proposedCopy";

/** The proposed i18n keys of the current section: key, KO, EN and the error codes each replaces. */
export function CopyTable({ title, columns, existing, entries }: {
  title: string;
  columns: { key: string; ko: string; en: string; codes: string };
  existing: string;
  entries: readonly CopyEntry[];
}) {
  return (
    <Box surface="raised" border="hairline" radius="panel" padding="lg">
      <Stack gap="md">
        <Typo.Label>{title}</Typo.Label>
        {entries.map((entry, index) => (
          <Stack key={entry.key} gap="xs">
            {index > 0 ? <Separator /> : null}
            <Stack align="row" gap="sm" cross="center" wrap>
              <Typo.Code wrap="anywhere">{entry.key}</Typo.Code>
              <Tag size="sm">{entry.surface}</Tag>
              {entry.existing ? <Tag size="sm" tone="accent">{existing}</Tag> : null}
            </Stack>
            <Typo.Body>{`${columns.ko}: ${entry.ko}`}</Typo.Body>
            <Typo.Body>{`${columns.en}: ${entry.en}`}</Typo.Body>
            {entry.codes ? (
              <Typo.Caption tone="secondary" wrap="anywhere">{`${columns.codes}: ${entry.codes.join(", ")}`}</Typo.Caption>
            ) : null}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

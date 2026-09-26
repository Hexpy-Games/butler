import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { MetaList, Stack, Typo } from "@/butler-ds";
import { formatCount } from "./usageSettingsFormat";

type UsageSectionRow = [
  string,
  {
    requestCount: number;
    chars: number;
    estimatedTokens: number;
  },
];

export function UsageSectionPanel({
  rows,
}: {
  rows: UsageSectionRow[];
}) {
  useAppLocale();
  return (
    <>
            {rows.map(([name, bucket]) => (
                <Stack key={name} align="row" justify="between" cross="start" gap="md" wrap>
                  <Stack gap="xs" grow basis="md" minWidth="0">
                    <Typo.Body as="div">{name}</Typo.Body>
                    <MetaList items={[
                      { label: appCopy.interfaceDetails.requests, value: formatCount(bucket.requestCount) },
                      { label: appCopy.interfaceDetails.characters, value: formatCount(bucket.chars) },
                    ]} />
                  </Stack>
                  <Typo.Body as="div" align="end" numeric="tabular" wrap="nowrap">
                    {formatCount(bucket.estimatedTokens)}
                  </Typo.Body>
                </Stack>
            ))}
    </>
  );
}

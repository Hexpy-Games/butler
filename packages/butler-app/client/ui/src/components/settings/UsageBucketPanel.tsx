import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { MetaList, Stack, Typo } from "@/butler-ds";
import {
  formatCount,
  type UsageNamedBucket,
} from "./usageSettingsFormat";

/** Token rows of a usage section (the section owns the title and empty state). */
export function UsageBucketPanel({ rows }: { rows: UsageNamedBucket[] }) {
  useAppLocale();
  return (
    <>
            {rows.map(({ name, bucket }) => (
                <Stack key={name} align="row" justify="between" cross="start" gap="md" wrap>
                  <Stack gap="xs" grow basis="md" minWidth="0">
                    <Typo.Body as="div">{name}</Typo.Body>
                    <MetaList items={[
                      { label: appCopy.interfaceDetails.input, value: formatCount(bucket.promptTokens) },
                      { label: appCopy.interfaceDetails.cache, value: formatCount(bucket.cachedTokens) },
                      { label: appCopy.interfaceDetails.outputLabel, value: formatCount(bucket.outputTokens) },
                    ]} />
                  </Stack>
                  <Typo.Body as="div" align="end" numeric="tabular" wrap="nowrap">
                    {formatCount(bucket.totalTokens)}
                  </Typo.Body>
                </Stack>
            ))}
    </>
  );
}

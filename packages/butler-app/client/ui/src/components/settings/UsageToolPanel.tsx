import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { MetaList, Stack, Typo } from "@/butler-ds";
import { formatCount } from "./usageSettingsFormat";

export function UsageToolPanel({
  rows,
}: {
  rows: Array<[string, UsageMonitorView["tools"]["byTool"][string]]>;
}) {
  useAppLocale();
  return (
    <>
            {rows.map(([name, bucket]) => (
                <Stack key={name} align="row" justify="between" cross="start" gap="md" wrap>
                  <Stack gap="xs" grow basis="md" minWidth="0">
                    <Typo.Body as="div">{name}</Typo.Body>
                    <MetaList items={[
                      { label: appCopy.interfaceDetails.results, value: formatCount(bucket.results) },
                      { label: appCopy.interfaceDetails.success, value: formatCount(bucket.successes) },
                      { label: appCopy.interfaceDetails.failures, value: formatCount(bucket.failures) },
                    ]} />
                  </Stack>
                  <Typo.Body as="div" align="end" numeric="tabular" wrap="nowrap">
                    {formatCount(bucket.calls)}
                  </Typo.Body>
                </Stack>
            ))}
    </>
  );
}

import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Fragment } from "react";
import { MetaList, Separator, Stack, SurfacePanel, Typo } from "@/butler-ds";
import { formatCount } from "./usageSettingsFormat";

export function UsageToolPanel({
  rows,
}: {
  rows: Array<[string, UsageMonitorView["tools"]["byTool"][string]]>;
}) {
  useAppLocale();
  return (
    <SurfacePanel elevation="none">
      <Stack gap="md">
        <Typo.Body as="div">{appCopy.interfaceDetails.callsByTool}</Typo.Body>
        {rows.length === 0 ? (
          <Typo.Caption>
            {appCopy.settings.descriptions.usageMonitorEmpty}
          </Typo.Caption>
        ) : (
          <Stack gap="xs">
            {rows.map(([name, bucket], index) => (
              <Fragment key={name}>
                {index > 0 ? <Separator space="md" /> : null}
                <Stack align="row" justify="between" cross="start" gap="md" wrap>
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
              </Fragment>
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}

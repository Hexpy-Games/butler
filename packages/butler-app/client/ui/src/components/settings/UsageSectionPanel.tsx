import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Fragment } from "react";
import { MetaList, Separator, Stack, SurfacePanel, Typo } from "@/butler-ds";
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
    <SurfacePanel elevation="none">
      <Stack gap="md">
        <Typo.Body as="div">{appCopy.interfaceDetails.contextEstimates}</Typo.Body>
        {rows.length === 0 ? (
          <Typo.Caption>{appCopy.settings.descriptions.usageMonitorEmpty}</Typo.Caption>
        ) : (
          <Stack gap="xs">
            {rows.map(([name, bucket], index) => (
              <Fragment key={name}>
                {index > 0 ? <Separator space="md" /> : null}
                <Stack align="row" justify="between" cross="start" gap="md" wrap>
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
              </Fragment>
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}

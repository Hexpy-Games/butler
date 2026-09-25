import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Fragment } from "react";
import { Separator, Stack, SurfacePanel, Typo } from "@/butler-ds";
import {
  formatCount,
  type UsageNamedBucket,
} from "./usageSettingsFormat";

export function UsageBucketPanel({
  title,
  rows,
}: {
  title: string;
  rows: UsageNamedBucket[];
}) {
  useAppLocale();
  return (
    <SurfacePanel elevation="none">
      <Stack gap="md">
        <Typo.Body as="div">{title}</Typo.Body>
        {rows.length === 0 ? (
          <Typo.Caption>
            {appCopy.settings.descriptions.usageMonitorEmpty}
          </Typo.Caption>
        ) : (
          <Stack gap="xs">
            {rows.map(({ name, bucket }, index) => (
              <Fragment key={name}>
                {index > 0 ? <Separator space="md" /> : null}
                <Stack align="row" justify="between" cross="start" gap="md" wrap>
                  <Stack gap="xs" grow basis="md" minWidth="0">
                    <Typo.Body as="div">{name}</Typo.Body>
                    <Typo.Caption>
                      {appCopy.interfaceDetails.input}{formatCount(bucket.promptTokens)} {appCopy.interfaceDetails.cache}{" "}
                      {formatCount(bucket.cachedTokens)} {appCopy.interfaceDetails.outputLabel}{" "}
                      {formatCount(bucket.outputTokens)}
                    </Typo.Caption>
                  </Stack>
                  <Typo.Body as="div" align="end" numeric="tabular" wrap="nowrap">
                    {formatCount(bucket.totalTokens)}
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

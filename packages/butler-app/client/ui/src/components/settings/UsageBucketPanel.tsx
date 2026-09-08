import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Stack, SurfacePanel, Typo } from "@/butler-ds";
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
              <Stack
                key={name}
                align="row"
                justify="between"
                cross="start"
                gap="md"
                wrap
                style={{
                  paddingBlock: "var(--space-sm)",
                  borderTop: index === 0 ? 0 : "1px solid var(--line)",
                }}
              >
                <Stack gap="xs" style={{ minWidth: 0, flex: "1 1 260px" }}>
                  <Typo.Body as="div">{name}</Typo.Body>
                  <Typo.Caption>
                    {appCopy.interfaceDetails.input}{formatCount(bucket.promptTokens)} {appCopy.interfaceDetails.cache}{" "}
                    {formatCount(bucket.cachedTokens)} {appCopy.interfaceDetails.outputLabel}{" "}
                    {formatCount(bucket.outputTokens)}
                  </Typo.Caption>
                </Stack>
                <Typo.Body
                  as="div"
                  style={{ textAlign: "right", whiteSpace: "nowrap" }}
                >
                  {formatCount(bucket.totalTokens)}
                </Typo.Body>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}

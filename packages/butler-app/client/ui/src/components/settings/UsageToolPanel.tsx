import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Stack, SurfacePanel, Typo } from "@/butler-ds";
import { formatCount } from "./usageSettingsFormat";

export function UsageToolPanel({
  rows,
}: {
  rows: Array<[string, UsageMonitorView["tools"]["byTool"][string]]>;
}) {
  return (
    <SurfacePanel elevation="none">
      <Stack gap="md">
        <Typo.Body as="div">도구별 호출</Typo.Body>
        {rows.length === 0 ? (
          <Typo.Caption>
            {appCopy.settings.descriptions.usageMonitorEmpty}
          </Typo.Caption>
        ) : (
          <Stack gap="xs">
            {rows.map(([name, bucket], index) => (
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
                    결과 {formatCount(bucket.results)} · 성공{" "}
                    {formatCount(bucket.successes)} · 실패{" "}
                    {formatCount(bucket.failures)}
                  </Typo.Caption>
                </Stack>
                <Typo.Body
                  as="div"
                  style={{ textAlign: "right", whiteSpace: "nowrap" }}
                >
                  {formatCount(bucket.calls)}
                </Typo.Body>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}

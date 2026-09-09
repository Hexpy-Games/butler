import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Stack, SurfacePanel, Typo } from "@/butler-ds";
import { UsageProviderRow } from "./UsageProviderRow";
import { formatCount } from "./usageSettingsFormat";

type UsageProvider =
  UsageMonitorView["providerUsage"]["providers"][number];

export function UsageProviderPanel({
  activeProviderId,
  providers,
}: {
  activeProviderId: string | null;
  providers: UsageProvider[];
}) {
  useAppLocale();
  return (
    <SurfacePanel elevation="none">
      <Stack gap="md">
        <Stack align="row" justify="between" cross="start" gap="md" wrap>
          <Stack gap="xs" style={{ minWidth: 0, flex: "1 1 260px" }}>
            <Typo.Body as="div">{appCopy.interfaceDetails.apiProviderUsage}</Typo.Body>
            <Typo.Caption>
              {activeProviderId
                ? appCopy.interfaceTemplates.activeProvider(activeProviderId)
                : appCopy.settings.descriptions.usageMonitorEmpty}
            </Typo.Caption>
          </Stack>
          <Typo.Body as="div" style={{ textAlign: "right" }}>
            {formatCount(providers.length)}
          </Typo.Body>
        </Stack>
        {providers.length === 0 ? (
          <Typo.Caption>
            {appCopy.settings.descriptions.usageMonitorEmpty}
          </Typo.Caption>
        ) : (
          <Stack gap="xs">
            {providers.map((provider, index) => (
              <UsageProviderRow
                key={provider.providerId}
                provider={provider}
                divider={index > 0}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}

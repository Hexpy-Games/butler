import { useAppLocale } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { UsageProviderRow } from "./UsageProviderRow";

type UsageProvider =
  UsageMonitorView["providerUsage"]["providers"][number];

/** Provider quota rows of the usage Providers section (the section owns title and empty state). */
export function UsageProviderPanel({ providers }: { providers: UsageProvider[] }) {
  useAppLocale();
  return (
    <>
      {providers.map((provider) => (
        <UsageProviderRow key={provider.providerId} provider={provider} />
      ))}
    </>
  );
}

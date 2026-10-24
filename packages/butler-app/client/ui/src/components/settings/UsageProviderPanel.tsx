import { useButlerStore } from "@/app/store";
import { useAppLocale } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { UsageProviderRow } from "./UsageProviderRow";

type UsageProvider =
  UsageMonitorView["providerUsage"]["providers"][number];

/** Provider quota rows of the usage Providers section (the section owns title and empty state). */
export function UsageProviderPanel({ providers }: { providers: UsageProvider[] }) {
  useAppLocale();
  const models = useButlerStore(store => store.modelCatalog.registered_models ?? []);
  const order = [...new Set(models.map(model => model.provider_id))];
  const registered = [...providers].sort((a, b) => {
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return rank(a.providerId) - rank(b.providerId);
  });
  return (
    <Stack gap="lg">
      {registered.map((provider) => (
        <UsageProviderRow key={provider.providerId} provider={provider} />
      ))}
    </Stack>
  );
}

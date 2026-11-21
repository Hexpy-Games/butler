import { HugeiconsIcon } from "@hugeicons/react-native";
import type { ModelSummary } from "../../../butler-protocol/src/index.ts";
import { icons, ProviderLogo, useTokens } from "@/ds";
import { providerLogoName } from "./providerLogo";

export function ModelMark({ model }: { model?: ModelSummary }) {
  const t = useTokens();
  const name = model && providerLogoName(model.provider_id, model.platform);
  return name ? <ProviderLogo name={name} size={t.length("--icon-size-lg")} />
    : <HugeiconsIcon icon={icons.Server} size={t.length("--icon-size-lg")} color={t.color("--text-primary")} />;
}

import { useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { SavedKeyRow } from "./SavedKeyRow";
import type { useSavedKeys } from "./hooks/useSavedKeys";
import { credentialDeleteRule, credentialDisplayName, defaultModelRefs } from "./savedKeysUtils";

/** The rows of Settings > Models > API keys (#217): one per saved key. */
export function SavedKeysRows({ keys }: { keys: ReturnType<typeof useSavedKeys> }) {
  useAppLocale();
  const catalog = useButlerStore((state) => state.modelCatalog);
  const settingsModel = useButlerStore((state) => state.settings.model);
  const defaults = defaultModelRefs(settingsModel, catalog);
  return keys.credentials.map((credential) => {
    const name = credentialDisplayName(credential, catalog);
    const rule = credentialDeleteRule(credential, defaults);
    return (
      <SavedKeyRow
        key={credential.id}
        credential={credential}
        name={name}
        rule={rule}
        busy={keys.busyId === credential.id}
        onReplace={(apiKey) => keys.replace(credential, name, apiKey)}
        onDelete={() => void keys.remove(credential, name, rule)}
      />
    );
  });
}

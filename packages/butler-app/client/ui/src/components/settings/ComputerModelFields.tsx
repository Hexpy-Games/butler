import { appCopy } from "@/app/copy.ts";
import type { SavedCredentialView } from "@/app/types";
import { ProviderMark } from "./ProviderMark";
import { SettingsSelect } from "./SettingsSelect";
import { COMPUTER_MODEL_CHOICES, type ComputerModelChoice, type useComputerModelChoice } from "./hooks/useComputerModelChoice";

export function ComputerModelFields({ model, savedKeys, busyReason }: {
  model: ReturnType<typeof useComputerModelChoice>;
  savedKeys: SavedCredentialView[];
  busyReason?: string;
}) {
  const copy = appCopy.computers.model;
  const { choice, keyId, setChoice, setKeyId } = model;
  return (
    <>
      <SettingsSelect controlWidth="full" label={copy.field} description={copy.hints[choice]} disabledReason={busyReason}
        value={choice} onChange={(value) => setChoice(value as ComputerModelChoice)}
        options={COMPUTER_MODEL_CHOICES.map((value) => ({ value, label: copy.options[value] }))}
      />
      {choice === "key" && (
        <SettingsSelect controlWidth="full" label={copy.keyField} placeholder={copy.chooseKey}
          disabledReason={busyReason ?? (savedKeys.length ? undefined : copy.noSavedKeys)}
          value={keyId} onChange={setKeyId} options={savedKeys.map((key) => ({
            value: key.id, label: key.label, icon: <ProviderMark providerId={key.provider_id} besideProviderName />,
          }))}
        />
      )}
    </>
  );
}

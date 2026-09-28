import { useState } from "react";
import {
  Button,
  ButtonContainer,
  IconTile,
  RefreshCcw,
  Stack,
  Tooltip,
  Trash2,
  Typo,
} from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { KeyCheckFailure } from "@/app/setupConnection.ts";
import type { SavedCredentialView } from "@/app/types.ts";
import { ProviderMark } from "./ProviderMark";
import { SavedKeyReplaceField } from "./SavedKeyReplaceField";
import { credentialStorageLabel, type CredentialDeleteRule } from "./savedKeysUtils";

interface SavedKeyRowProps {
  credential: SavedCredentialView;
  name: string;
  rule: CredentialDeleteRule;
  busy: boolean;
  onReplace: (apiKey: string) => Promise<KeyCheckFailure | null>;
  onDelete: () => void;
}

/** One saved API key: provider, masked key, the models using it, where it is kept; Replace and Delete. */
export function SavedKeyRow({ credential, name, rule, busy, onReplace, onDelete }: SavedKeyRowProps) {
  useAppLocale();
  const copy = appCopy.settings.savedKeys;
  const [replacing, setReplacing] = useState(false);
  const usedBy = copy.usedBy(credential.model_refs?.length ?? 0);
  const storage = credentialStorageLabel(credential.storage, copy.storage);

  async function submit(apiKey: string) {
    const failure = await onReplace(apiKey);
    if (!failure) setReplacing(false);
    return failure;
  }

  return (
    <Stack gap="sm" data-test-class="saved-key-row">
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <Stack align="row" cross="start" gap="md">
          <IconTile size="sm"><ProviderMark providerId={credential.provider_id} /></IconTile>
          <div>
            <Typo.PanelSectionTitle as="h3">{name}</Typo.PanelSectionTitle>
            <Stack gap="xs">
              <Typo.Caption>{credential.masked_value}</Typo.Caption>
              <Typo.Caption tone="tertiary">{`${usedBy} · ${storage}`}</Typo.Caption>
            </Stack>
          </div>
        </Stack>
        <ButtonContainer size="sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || replacing}
            aria-expanded={replacing}
            aria-label={copy.replaceLabel(name)}
            onClick={() => setReplacing(true)}
          >
            <RefreshCcw size="sm" /> {copy.replace}
          </Button>
          <SavedKeyDeleteButton name={name} blocked={rule.kind === "blocked"} disabled={busy || replacing} onDelete={onDelete} />
        </ButtonContainer>
      </Stack>
      {replacing ? (
        <SavedKeyReplaceField credentialId={credential.id} onSubmit={submit} onCancel={() => setReplacing(false)} />
      ) : null}
    </Stack>
  );
}

/** The default model's key cannot be deleted: disabled, with the reason as its tooltip. */
function SavedKeyDeleteButton({ name, blocked, disabled, onDelete }: {
  name: string;
  blocked: boolean;
  disabled: boolean;
  onDelete: () => void;
}) {
  const copy = appCopy.settings.savedKeys;
  const label = blocked ? `${copy.deleteLabel(name)}. ${copy.deleteDefaultHint}` : copy.deleteLabel(name);
  const button = (
    <Button type="button" variant="outline" size="sm" disabled={disabled || blocked} aria-label={label} onClick={onDelete}>
      <Trash2 size="sm" /> {copy.delete}
    </Button>
  );
  return blocked ? <Tooltip label={copy.deleteDefaultHint}>{button}</Tooltip> : button;
}

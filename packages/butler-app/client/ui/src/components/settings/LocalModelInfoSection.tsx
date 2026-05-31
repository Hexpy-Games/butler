import { Button, Save, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { LocalModelDiscoveryResult } from "@/app/types.ts";
import { LocalModelDiscoveryForm } from "./LocalModelDiscoveryForm";
import { LocalModelManualForm } from "./LocalModelManualForm";
import { SettingsSection } from "./SettingsFormComponents";

interface LocalModelInfoSectionProps {
  discovery: LocalModelDiscoveryResult | null;
  selectedModelRef: string;
  setSelectedModelRef: (value: string) => void;
  manualModelId: string;
  setManualModelId: (value: string) => void;
  manualDisplayName: string;
  setManualDisplayName: (value: string) => void;
  manualContext: string;
  setManualContext: (value: string) => void;
  status: string;
  hasUnsavedChanges: boolean;
  canRegister: boolean;
  registering: boolean;
  isEditing: boolean;
  onRegister: () => void;
}

export function LocalModelInfoSection({
  discovery,
  selectedModelRef,
  setSelectedModelRef,
  manualModelId,
  setManualModelId,
  manualDisplayName,
  setManualDisplayName,
  manualContext,
  setManualContext,
  status,
  hasUnsavedChanges,
  canRegister,
  registering,
  isEditing,
  onRegister,
}: LocalModelInfoSectionProps) {
  const copy = appCopy.settings.localModels;

  return (
    <SettingsSection title={copy.modelInfoTitle}>
      <Stack gap="md">
        {status ? <Typo.Caption role="status">{status}</Typo.Caption> : null}
        {hasUnsavedChanges ? (
          <Typo.Caption role="alert">{copy.unsavedChanges}</Typo.Caption>
        ) : null}
        {discovery ? (
          <LocalModelDiscoveryForm
            discovery={discovery}
            selectedModelRef={selectedModelRef}
            setSelectedModelRef={setSelectedModelRef}
          />
        ) : null}
        <LocalModelManualForm
          manualModelId={manualModelId}
          setManualModelId={setManualModelId}
          manualDisplayName={manualDisplayName}
          setManualDisplayName={setManualDisplayName}
          manualContext={manualContext}
          setManualContext={setManualContext}
        />
        <Button type="button" disabled={!canRegister} onClick={onRegister}>
          <Save size={15} />{" "}
          {registering
            ? copy.saving
            : isEditing
              ? copy.saveModel
              : copy.registerModel}
        </Button>
      </Stack>
    </SettingsSection>
  );
}

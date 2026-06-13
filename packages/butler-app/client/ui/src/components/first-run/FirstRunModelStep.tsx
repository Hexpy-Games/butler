import {
  firstRunCopy,
  type FirstRunLanguage,
} from "@/app/firstRunSetup.ts";
import {
  Button,
  ButtonContainer,
  SetupWizardContent,
  Stack,
  Typo,
} from "@/butler-ds";
import { ButlerModelSettings } from "@/components/settings/ButlerModelSettings";
import { ModelAddEditPage } from "@/components/settings/ModelAddEditPage";
import { ModelManagementPage } from "@/components/settings/ModelManagementPage";
import { ModelSettingsTitle } from "@/components/settings/ModelSettingsTitle";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

interface FirstRunModelStepProps {
  copy: FirstRunCopy;
  modelLoadFailed: boolean;
  modelSaveStatus: string;
  modelSettingsReady: boolean;
  modelSetupReady: boolean;
  onRetryModelLoad: () => void;
  onRetryModelSave: () => void;
  onSaveModel: () => void;
}

export function FirstRunModelStep({
  copy,
  modelLoadFailed,
  modelSaveStatus,
  modelSettingsReady,
  modelSetupReady,
  onRetryModelLoad,
  onRetryModelSave,
  onSaveModel,
}: FirstRunModelStepProps) {
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);
  const canFinishModelSetup = modelSetupReady && modelRoute.page !== "edit";

  return (
    <SetupWizardContent width="wide">
      <Stack gap="md">
        <Typo.H3 as="h1">{copy.modelTitle}</Typo.H3>
        <Typo.Body>{copy.modelBody}</Typo.Body>
      </Stack>
      {modelLoadFailed ? (
        <Stack gap="md">
          <Typo.Body>{modelSaveStatus}</Typo.Body>
          <ButtonContainer size="default">
            <Button type="button" variant="outline" onClick={onRetryModelLoad}>
              {copy.modelRetry}
            </Button>
          </ButtonContainer>
        </Stack>
      ) : modelSettingsReady ? (
        <>
          {modelSaveStatus && (
            <Stack gap="sm">
              <Typo.Body>{modelSaveStatus}</Typo.Body>
              {modelSaveStatus === copy.modelSaveFailed && (
                <ButtonContainer size="default">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onRetryModelSave}
                  >
                    {copy.modelRetry}
                  </Button>
                </ButtonContainer>
              )}
            </Stack>
          )}
          <FirstRunModelSettingsSurface />
          {canFinishModelSetup && (
            <ButtonContainer size="default">
              <Button type="button" onClick={onSaveModel}>
                {copy.modelSave}
              </Button>
            </ButtonContainer>
          )}
        </>
      ) : (
        <Typo.Body>{modelSaveStatus}</Typo.Body>
      )}
    </SetupWizardContent>
  );
}

function FirstRunModelSettingsSurface() {
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);
  const backModelRoute = useSettingsUIStore((state) => state.backModelRoute);
  const resetModelRoute = useSettingsUIStore((state) => state.resetModelRoute);
  const openModelManagement = useSettingsUIStore(
    (state) => state.openModelManagement,
  );

  return (
    <Stack gap="md">
      <ModelSettingsTitle
        modelRoute={modelRoute}
        onBack={backModelRoute}
        onRoot={resetModelRoute}
        onManagement={openModelManagement}
      />
      {modelRoute.page === "management" ? (
        <ModelManagementPage />
      ) : modelRoute.page === "add" ? (
        <ModelAddEditPage />
      ) : modelRoute.page === "edit" ? (
        <ModelAddEditPage modelRef={modelRoute.modelRef} />
      ) : (
        <ButlerModelSettings />
      )}
    </Stack>
  );
}

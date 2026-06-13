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
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { ProviderAuthMethod } from "@/app/types.ts";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];
const FIRST_RUN_HOSTED_AUTH_METHODS: ProviderAuthMethod[] = [
  "api_key",
  "codex_oauth",
];

interface FirstRunModelStepProps {
  copy: FirstRunCopy;
  modelLoadFailed: boolean;
  modelSaveStatus: string;
  modelSettingsReady: boolean;
  onRetryModelLoad: () => void;
  onRetryModelSave: () => void;
}

export function FirstRunModelStep({
  copy,
  modelLoadFailed,
  modelSaveStatus,
  modelSettingsReady,
  onRetryModelLoad,
  onRetryModelSave,
}: FirstRunModelStepProps) {
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
        </>
      ) : (
        <Typo.Body>{modelSaveStatus}</Typo.Body>
      )}
    </SetupWizardContent>
  );
}

function FirstRunModelSettingsSurface() {
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);

  return (
    <Stack gap="md">
      {modelRoute.page === "management" ? (
        <ModelManagementPage />
      ) : modelRoute.page === "add" ? (
        <ModelAddEditPage allowedAuthMethods={FIRST_RUN_HOSTED_AUTH_METHODS} />
      ) : modelRoute.page === "edit" ? (
        <ModelAddEditPage
          allowedAuthMethods={FIRST_RUN_HOSTED_AUTH_METHODS}
          modelRef={modelRoute.modelRef}
        />
      ) : (
        <ButlerModelSettings />
      )}
    </Stack>
  );
}

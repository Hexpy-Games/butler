import { useAppLocale } from "@/app/copy.ts";
import {
  ArrowLeft,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbButton,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  IconButton,
  Stack,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SettingsModelRoute } from "@/stores/settingsUIStore.ts";

interface ModelSettingsTitleProps {
  modelRoute: SettingsModelRoute;
  onBack: () => void;
  onRoot: () => void;
  onManagement: () => void;
}

export function ModelSettingsTitle({
  modelRoute,
  onBack,
  onRoot,
  onManagement,
}: ModelSettingsTitleProps) {
  useAppLocale();
  const copy = appCopy.settings;
  const pageTitle =
    modelRoute.page === "management"
      ? copy.modelManagement.title
      : modelRoute.page === "edit"
        ? copy.modelManagement.editTitle
        : copy.modelManagement.addTitle;
  const hidden = modelRoute.page === "root";

  return (
    <Stack
      align="row"
      cross="center"
      gap="sm"
      aria-hidden={hidden}
      data-test-class="settings-model-route-nav"
      invisible={hidden}
    >
      <IconButton label={copy.back} onClick={onBack}>
        <ArrowLeft size="md" />
      </IconButton>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbButton onClick={onRoot}>{copy.sections.models}</BreadcrumbButton>
          </BreadcrumbItem>
          {modelRoute.page === "add" || modelRoute.page === "edit" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbButton onClick={onManagement}>{copy.modelManagement.title}</BreadcrumbButton>
              </BreadcrumbItem>
            </>
          ) : null}
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </Stack>
  );
}

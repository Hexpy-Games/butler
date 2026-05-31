import {
  ArrowLeft,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
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
      style={{ visibility: hidden ? "hidden" : "visible" }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        aria-label={copy.back}
      >
        <ArrowLeft size={15} />
      </Button>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button type="button" onClick={onRoot}>
                {copy.sections.models}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {modelRoute.page === "add" || modelRoute.page === "edit" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <button type="button" onClick={onManagement}>
                    {copy.modelManagement.title}
                  </button>
                </BreadcrumbLink>
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

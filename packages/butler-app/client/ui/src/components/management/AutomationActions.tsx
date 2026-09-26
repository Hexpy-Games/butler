import { useAppLocale } from "@/app/copy.ts";
import { ArrowLeft, Clock3, Play, RotateCcw, Save, Trash2 } from "@/butler-ds";
import { Button, ButtonContainer, IconButton } from "@/butler-ds";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbButton,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/butler-ds";
import { Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useAutomationStore } from "@/stores/automationStore";

interface AutomationActionsProps {
  onBack: () => void;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

export function AutomationActions({
  onBack,
  onRun,
  onPause,
  onResume,
  onDelete,
}: AutomationActionsProps) {
  useAppLocale();
  const isNew = useAutomationStore((state) => state.isNew);
  const title = useAutomationStore((state) => state.title);
  const state = useAutomationStore((state) => state.state);
  const saving = useAutomationStore((state) => state.saving);
  const copy = appCopy.automations;

  return (
    <Stack
      align="row"
      justify="between"
      cross="center"
      gap="md"
      data-test-class="automation-detail-titlebar"
    >
      <Stack align="row" cross="center" gap="sm">
        <IconButton label={copy.backLabel} onClick={onBack}>
          <ArrowLeft size="md" />
        </IconButton>
        <Breadcrumb label={appCopy.common.breadcrumb}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbButton onClick={onBack}>{copy.title}</BreadcrumbButton>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>
                {isNew ? copy.new : title || copy.detailFallback}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Stack>
      <ButtonContainer size="default">
        {!isNew && (
          <>
            <Button type="button" variant="outline" onClick={onRun}>
              <Play size="md" /> {copy.runNow}
            </Button>
            {state === "paused" ? (
              <Button type="button" variant="outline" onClick={onResume}>
                <RotateCcw size="md" /> {copy.resume}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={onPause}>
                <Clock3 size="md" /> {copy.pause}
              </Button>
            )}
            <Button type="button" variant="destructive" onClick={onDelete}>
              <Trash2 size="md" /> {appCopy.common.delete}
            </Button>
          </>
        )}
        <Button type="submit" disabled={saving}>
          <Save size="md" /> {appCopy.common.save}
        </Button>
      </ButtonContainer>
    </Stack>
  );
}

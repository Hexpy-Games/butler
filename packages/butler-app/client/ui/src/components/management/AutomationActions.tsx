import { ArrowLeft, Clock3, Play, RotateCcw, Save, Trash2 } from "@/butler-ds";
import { Button, ButtonContainer } from "@/butler-ds";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={copy.backLabel}
        >
          <ArrowLeft size={15} />
        </Button>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button type="button" onClick={onBack}>
                  {copy.title}
                </button>
              </BreadcrumbLink>
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
              <Play size={15} /> {copy.runNow}
            </Button>
            {state === "paused" ? (
              <Button type="button" variant="outline" onClick={onResume}>
                <RotateCcw size={15} /> {copy.resume}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={onPause}>
                <Clock3 size={15} /> {copy.pause}
              </Button>
            )}
            <Button type="button" variant="destructive" onClick={onDelete}>
              <Trash2 size={15} /> {appCopy.common.delete}
            </Button>
          </>
        )}
        <Button type="submit" disabled={saving}>
          <Save size={15} /> {appCopy.common.save}
        </Button>
      </ButtonContainer>
    </Stack>
  );
}

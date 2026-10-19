import { useAppLocale } from "@/app/copy.ts";
import {
  ArrowLeft,
  Clock3,
  MoreHorizontal,
  Play,
  RotateCcw,
  Save,
  Trash2,
} from "@/butler-ds";
import {
  Button,
  ButtonContainer,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from "@/butler-ds";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbButton,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/butler-ds";
import { Stack } from "@/butler-ds";
import { Typo } from "@/butler-ds";
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
  const detailTitle = isNew ? copy.new : title || copy.detailFallback;

  return (
    <Stack
      align="row"
      justify="between"
      cross="center"
      gap="md"
      minWidth="0"
      data-test-class="automation-detail-titlebar"
    >
      <Stack.Item grow minWidth="0">
        <Stack align="row" cross="center" gap="sm" minWidth="0">
          <IconButton label={copy.backLabel} onClick={onBack}>
            <ArrowLeft size="md" />
          </IconButton>
          <Stack.Item grow minWidth="0">
            <Breadcrumb label={appCopy.common.breadcrumb}>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbButton onClick={onBack}>{copy.title}</BreadcrumbButton>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>
                    <Typo.Label as="span" minWidth="0" title={detailTitle} truncate>
                      {detailTitle}
                    </Typo.Label>
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </Stack.Item>
        </Stack>
      </Stack.Item>
      <ButtonContainer size="sm" shrink={false}>
        {!isNew && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={appCopy.common.more}>
                  <MoreHorizontal size="md" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onRun}>
                  <Play size="sm" /> {copy.runNow}
                </DropdownMenuItem>
                {state === "paused" ? (
                  <DropdownMenuItem onSelect={onResume}>
                    <RotateCcw size="sm" /> {copy.resume}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={onPause}>
                    <Clock3 size="sm" /> {copy.pause}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 size="sm" /> {appCopy.common.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <Button type="submit" size="sm" disabled={saving}>
          <Save size="sm" /> {appCopy.common.save}
        </Button>
      </ButtonContainer>
    </Stack>
  );
}

import { useAppLocale } from "@/app/copy.ts";
import {
  Button,
  Clickable,
  DashboardHeader,
  EmptyLine,
  ListRow,
  ManagementPage,
  Plus,
  SkeletonRows,
  Stack,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AutomationSummary } from "@/app/types.ts";
import { accessLabel, accessModeIcon, isAccessMode } from "@/components/conversation/accessModeUtils";

interface AutomationsListProps {
  automations: AutomationSummary[];
  /** False until the first load settles: show skeleton rows, not the empty line. */
  loaded?: boolean;
  selectedId?: string | null;
  onSelectAutomation: (automationId: string) => void;
  onNewAutomation: () => void;
}

export function AutomationsList({
  automations,
  loaded = true,
  selectedId,
  onSelectAutomation,
  onNewAutomation,
}: AutomationsListProps) {
  useAppLocale();
  const copy = appCopy.automations;

  return (
    <ManagementPage dataTestClass="automations-view">
      <DashboardHeader
        title={copy.title}
        meta={copy.scheduledCount(automations.length)}
        action={
          <Button type="button" variant="outline" onClick={onNewAutomation}>
            <Plus size="md" /> {copy.new}
          </Button>
        }
      />
      <Stack gap="xs">
        {!loaded ? (
          <SkeletonRows rows={3} label={appCopy.settings.sectionState.loading} />
        ) : automations.length > 0 ? (
          automations.map((automation) => (
            <Clickable
              aria-current={selectedId === automation.id ? "page" : undefined}
              key={automation.id}
              onClick={() => onSelectAutomation(automation.id)}
              stretch
            >
              <ListRow
                icon={isAccessMode(automation.access_mode) ? accessModeIcon(automation.access_mode) : undefined}
                title={automation.title}
                description={automation.target_label}
                meta={[
                  automation.state,
                  automation.interval_label,
                  isAccessMode(automation.access_mode) ? accessLabel(automation.access_mode) : "",
                ].filter(Boolean).join(" / ")}
              />
            </Clickable>
          ))
        ) : (
          <EmptyLine message={copy.empty} />
        )}
      </Stack>
    </ManagementPage>
  );
}

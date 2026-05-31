import {
  Button,
  Clickable,
  DashboardHeader,
  EmptyLine,
  ListRow,
  ManagementPage,
  Plus,
  Stack,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AutomationSummary } from "@/app/types.ts";

interface AutomationsListProps {
  automations: AutomationSummary[];
  selectedId?: string | null;
  onSelectAutomation: (automationId: string) => void;
  onNewAutomation: () => void;
}

export function AutomationsList({
  automations,
  selectedId,
  onSelectAutomation,
  onNewAutomation,
}: AutomationsListProps) {
  const copy = appCopy.automations;

  return (
    <ManagementPage dataTestClass="automations-view">
      <DashboardHeader
        title={copy.title}
        meta={copy.scheduledCount(automations.length)}
        action={
          <Button type="button" variant="outline" onClick={onNewAutomation}>
            <Plus size={16} /> {copy.new}
          </Button>
        }
      />
      <Stack gap="xs">
        {automations.length > 0 ? (
          automations.map((automation) => (
            <Clickable
              aria-current={selectedId === automation.id ? "page" : undefined}
              key={automation.id}
              onClick={() => onSelectAutomation(automation.id)}
              stretch
            >
              <ListRow
                title={automation.title}
                description={automation.target_label}
                meta={`${automation.state} / ${automation.interval_label}`}
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

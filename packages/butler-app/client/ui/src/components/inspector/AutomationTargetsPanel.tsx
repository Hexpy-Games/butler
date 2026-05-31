import { Clock3 } from "@/butler-ds";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { Clickable, ListRow, Section, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AutomationTargetSummary } from "@/app/types.ts";
import { inspectorInset } from "./inspectorLayout.ts";

export function AutomationTargetsPanel({
  automations,
  onOpenAutomation,
}: {
  automations: AutomationTargetSummary[];
  onOpenAutomation: (automationId: string) => void;
}) {
  return (
    <Section
      title={appCopy.automations.title}
      gap="sm"
      style={inspectorInset}
    >
      {automations.length > 0 ? (
        <Stack gap="xs">
          {automations.map((automation) => (
            <Clickable
              key={automation.automation_id}
              onClick={() => onOpenAutomation(automation.automation_id)}
              stretch
            >
              <ListRow
                icon={<Clock3 size={16} />}
                title={automation.title}
                meta={automation.interval_label}
              />
            </Clickable>
          ))}
        </Stack>
      ) : (
        <EmptyPanelLine label={appCopy.automations.inspector.empty} />
      )}
    </Section>
  );
}

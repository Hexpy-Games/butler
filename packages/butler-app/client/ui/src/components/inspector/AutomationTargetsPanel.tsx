import { SessionSectionHeader } from "../session-info/SessionSection.tsx";
import { scheduleFrequency } from "@/app/scheduleLabels";
import { useAppLocale } from "@/app/copy.ts";
import { Clock3 } from "@/butler-ds";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { Clickable, InspectorInset, ListRow, Section, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AutomationTargetSummary } from "@/app/types.ts";

export function AutomationTargetsPanel({
  automations, compact = false,
  onOpenAutomation,
}: {
  automations: AutomationTargetSummary[];
  compact?: boolean;
  onOpenAutomation: (automationId: string) => void;
}) {
  useAppLocale();
  return (
    <InspectorInset>
      <Section
        title={compact ? undefined : appCopy.automations.title}
        gap="sm"
      >
        {compact && <SessionSectionHeader title={appCopy.automations.title} count={automations.length} />}
        {automations.length > 0 ? (
          <Stack gap="xs">
            {automations.map((automation) => (
              <Clickable
                key={automation.automation_id}
                onClick={() => onOpenAutomation(automation.automation_id)}
                stretch
              >
                <ListRow
                  icon={<Clock3 size="md" />}
                  title={automation.title}
                  meta={scheduleFrequency(automation)}
                />
              </Clickable>
            ))}
          </Stack>
        ) : (
          <EmptyPanelLine label={appCopy.automations.inspector.empty} />
        )}
      </Section>
    </InspectorInset>
  );
}

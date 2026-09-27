import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ActivityReadModel } from "@/app/conversation-progress";
import { Box, Stack, Typo } from "@/butler-ds";

type DecisionReadModel = Extract<ActivityReadModel, { type: "decision" }>;

export function TurnDecisionRow({ decision }: { decision: DecisionReadModel }) {
  useAppLocale();
  const details = [decision.rationale, decision.nextStep].filter(
    (line): line is string => Boolean(line?.trim()),
  );

  return (
    <Box
      as="article"
      paddingStart="2xl"
      data-test-class="turn-decision-row"
      aria-label={appCopy.interfacePanels.assistantDecision}
    >
      <Stack gap="xs">
      <Typo.Body
        as="p"
        tone="primary"
        weight="medium"
        wrap="anywhere"
        data-test-class="turn-decision-summary"
      >
        {decision.summary}
      </Typo.Body>
      {details.map((line, index) => (
        <Typo.Body
          as="p"
          tone="secondary"
          weight="regular"
          wrap="anywhere"
          data-test-class="turn-decision-detail"
          key={`${decision.summary}:detail:${index}`}
        >
          {line}
        </Typo.Body>
      ))}
      </Stack>
    </Box>
  );
}

import type { ActivityReadModel } from "@/app/conversation-progress";
import { Stack, Typo } from "@/butler-ds";

type DecisionReadModel = Extract<ActivityReadModel, { type: "decision" }>;

const rowStyle = {
  boxSizing: "border-box",
  maxWidth: "100%",
  minWidth: 0,
  padding: "0 0 0 var(--space-6)",
} as const;

const summaryStyle = {
  minWidth: 0,
  margin: 0,
  overflowWrap: "anywhere",
  color: "var(--text-primary)",
  fontWeight: "var(--font-weight-medium)",
} as const;

const detailStyle = {
  minWidth: 0,
  margin: 0,
  overflowWrap: "anywhere",
  color: "var(--text-secondary)",
  fontWeight: "var(--font-weight-regular)",
} as const;

export function TurnDecisionRow({ decision }: { decision: DecisionReadModel }) {
  const details = [decision.rationale, decision.nextStep].filter(
    (line): line is string => Boolean(line?.trim()),
  );

  return (
    <Stack
      as="article"
      gap="xs"
      style={rowStyle}
      data-test-class="turn-decision-row"
      aria-label="Assistant decision"
    >
      <Typo.Body
        as="p"
        style={summaryStyle}
        data-test-class="turn-decision-summary"
      >
        {decision.summary}
      </Typo.Body>
      {details.map((line, index) => (
        <Typo.Body
          as="p"
          style={detailStyle}
          data-test-class="turn-decision-detail"
          key={`${decision.summary}:detail:${index}`}
        >
          {line}
        </Typo.Body>
      ))}
    </Stack>
  );
}

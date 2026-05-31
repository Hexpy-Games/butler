import type { WorkBlockView } from "@/app/types.ts";
import { Stack, Typo } from "@/butler-ds";

export function WorkDecisionBody({ block }: { block: WorkBlockView }) {
  const lines = [block.decision_rationale, block.decision_next_step].filter(
    (line): line is string => Boolean(line?.trim()),
  );
  if (lines.length === 0) return null;
  return (
    <Stack gap="xs" as="span">
      {lines.map((line, index) => (
        <Typo.Body as="span" key={`${block.id}:decision:${index}`}>
          {line}
        </Typo.Body>
      ))}
    </Stack>
  );
}

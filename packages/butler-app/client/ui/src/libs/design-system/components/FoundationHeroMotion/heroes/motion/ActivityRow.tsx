import { MessageRow, MessageStatusLabel } from "../../../../blocks/MessageRow";
import { ButlerThinkingMark } from "../../../ButlerThinkingMark";
import { RollingStatusLine } from "../../../RollingStatusLine";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import type { MotionCopy } from "./motionCopy";

/** The activity row while the answer is generated: the working mark beside the status. */
export function ActivityRow({ copy }: { copy: MotionCopy }) {
  return (
    <MessageRow activity role="assistant">
      <Stack gap="md">
        <RollingStatusLine title={copy.generating}>
          <MessageStatusLabel mark={<ButlerThinkingMark state="working" />} shimmer title={copy.generating}>
            <Typo.Body as="p" tone="secondary" weight="regular">{copy.generating}</Typo.Body>
          </MessageStatusLabel>
        </RollingStatusLine>
      </Stack>
    </MessageRow>
  );
}

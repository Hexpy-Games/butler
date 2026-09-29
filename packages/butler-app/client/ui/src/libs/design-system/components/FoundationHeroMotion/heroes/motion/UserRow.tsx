import { MessageFooter, MessageRow } from "../../../../blocks/MessageRow";
import { CopyButton } from "../../../CopyButton";
import { Typo } from "../../../Typo";
import type { MotionCopy } from "./motionCopy";
import type { Name } from "./MotionTurn";

export function UserRow({ copy, t, id }: { copy: MotionCopy; t: Name; id: string }) {
  return (
    <div data-t={t(`${id}-user`)}>
      <MessageRow role="user" footer={(
        <MessageFooter dataTestClass="user-message-footer">
          <Typo.Text as="time" numeric="tabular">{copy.sent}</Typo.Text>
          <CopyButton label={copy.copyMessage} copiedLabel={copy.copyMessage} text={copy.ask} />
        </MessageFooter>
      )}>
        <Typo.Text as="div" data-m={t(`${id}-ask`)} lineClamp={5} wrap="pre">{copy.ask}</Typo.Text>
      </MessageRow>
    </div>
  );
}

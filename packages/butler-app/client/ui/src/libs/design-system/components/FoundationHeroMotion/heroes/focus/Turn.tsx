import { MessageRow } from "../../../../blocks/MessageRow";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** The conversation: one exchange. */
export function Turn({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.turn}>
      <MessageRow role="user">{copy.ask}</MessageRow>
      <MessageRow role="assistant">{copy.reply}</MessageRow>
    </div>
  );
}

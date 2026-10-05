import { type ReactNode } from "react";
import {
  ComposerCard, ComposerCardInlineAction, ComposerSendButton,
  ComposerCardEditable, ComposerCardEditor, ComposerCardPlaceholder,
} from "../../../../blocks/ComposerCard";
import { ComposerControl } from "../../../../blocks/ComposerControl";
import { PillButton } from "../../../PillButton";
import { ButtonContainer } from "../../../ButtonContainer";
import { ScrollArea } from "../../../../blocks/ScrollArea";
import { Box } from "../../../Box";
import { AiChip, Plus, ShieldQuestion } from "../../../Icons";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/**
 * The app's composer with its glass controls and inline send.
 * Live: its stops are marks, the draft types in behind a caret (a text field
 * shows focus as its caret, never a ring), and Send wakes once there is text.
 * At rest (the poster) the draft is typed and Send carries its focus outline.
 */
export function Composer({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  const mark = (n: string, node: ReactNode) => (live ? <Mark n={n}>{node}</Mark> : node);
  const send = <ComposerSendButton aria-label={copy.send} mode="send" />;
  return (
    <ComposerCard controls={
      <ScrollArea orientation="x" flush><ButtonContainer size="sm" wrap={false} grow>
{mark("plus", <PillButton surface="glass" size="icon-lg" aria-label={copy.more}><Plus size="md" /></PillButton>)}
{mark("perm", <ComposerControl surface="glass" size="lg" compact="label" icon={<ShieldQuestion size="sm" />} label={copy.access} permissionTone="ask" />)}
          <Box grow aria-hidden="true" />
          {mark("model", <ComposerControl surface="glass" size="lg" icon={<AiChip size="sm" />} label={copy.model} />)}
      </ButtonContainer></ScrollArea>
    }>
      <ComposerCardInlineAction action={live ? (
          <span className={s.sendSwap}>
            <span data-t="send-off"><ComposerSendButton aria-label={copy.send} disabled mode="send" /></span>
            <span data-t="send-on"><Mark n="send">{send}</Mark></span>
          </span>
        ) : <span className={s.ringOutline}>{send}</span>}>
        <Mark block n={live ? "field" : "field-rest"}>
          <ComposerCardEditor>
            <ComposerCardEditable><div /></ComposerCardEditable>
            {live ? <ComposerCardPlaceholder><span data-t="ph">{copy.placeholder}</span></ComposerCardPlaceholder> : null}
            <span className={s.draft}>
              {live ? <Mark n="typed"><R name="typed">{copy.typed}</R></Mark> : copy.typed}
              {live ? <span className={s.caret} data-t="caret" /> : null}
            </span>
          </ComposerCardEditor>
        </Mark>
      </ComposerCardInlineAction>
    </ComposerCard>
  );
}

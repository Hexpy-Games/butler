import { type ReactNode } from "react";
import {
  ComposerCard, ComposerCardExpandedBody, ComposerCardExpandedControls, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton,
  ComposerCardEditable, ComposerCardEditor, ComposerCardPlaceholder,
} from "../../../../blocks/ComposerCard";
import { ComposerControl } from "../../../../blocks/ComposerControl";
import { IconButton } from "../../../IconButton";
import { AiChip, Plus, ShieldQuestion } from "../../../Icons";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/**
 * The app's composer with its real toolbar (more, access, model, send).
 * Live: its stops are marks, the draft types in behind a caret (a text field
 * shows focus as its caret, never a ring), and Send wakes once there is text.
 * At rest (the poster) the draft is typed and Send carries its focus outline.
 */
export function Composer({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  const mark = (n: string, node: ReactNode) => (live ? <Mark n={n}>{node}</Mark> : node);
  const send = <ComposerSendButton aria-label={copy.send} mode="send" />;
  return (
    <ComposerCard controls={<ComposerCardToolbar>
        {mark("plus", <IconButton label={copy.more}><Plus size="md" /></IconButton>)}
        <ComposerCardExpandedControls>
          {mark("perm", <ComposerControl compact="label" icon={<ShieldQuestion size="sm" />} label={copy.access} permissionTone="ask" />)}
          <ComposerCardToolbarSpacer />
          {mark("model", <ComposerControl icon={<AiChip size="sm" />} label={copy.model} />)}
        </ComposerCardExpandedControls>
        {live ? (
          <span className={s.sendSwap}>
            <span data-t="send-off"><ComposerSendButton aria-label={copy.send} disabled mode="send" /></span>
            <span data-t="send-on"><Mark n="send">{send}</Mark></span>
          </span>
        ) : <span className={s.ringOutline}>{send}</span>}
      </ComposerCardToolbar>}>
      <ComposerCardExpandedBody>
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
      </ComposerCardExpandedBody>

    </ComposerCard>
  );
}

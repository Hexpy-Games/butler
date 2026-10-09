import { ButlerThinkingMark } from "../../../components/ButlerThinkingMark";
import { Button } from "../../../components/Button";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import { Key, Pick, Popup, ShieldQuestion, Square, X } from "../../../components/Icons";
import { PageBand } from "../../PageBand";
import type { BrowserDemoCopy } from "./copy";

export type DemoBandKind = "agent" | "user" | "waiting" | "need-you" | "pick" | "popup";

/** The page band for each state, as the App's band container composes it. */
export function DemoBand({ kind, copy }: { kind: DemoBandKind; copy: BrowserDemoCopy }) {
  const stop = <Button size="xs" variant="outline" iconStart={<Square size="sm" />} text={copy.stopTask} />;
  switch (kind) {
    case "agent":
      return (
        <PageBand tone="agent" icon={<ButlerThinkingMark size="sm" state="working" />} label={copy.agentUsing} detail={copy.step}
          actions={<ButtonContainer size="xs"><Button size="xs" variant="outline" text={copy.takeOver} />{stop}</ButtonContainer>} />
      );
    case "user":
      return (
        <PageBand tone="user" icon={<ButlerThinkingMark size="sm" />} label={copy.userControl} detail={copy.butlerWaits}
          actions={<ButtonContainer size="xs"><Button size="xs" text={copy.giveBack} />{stop}</ButtonContainer>} />
      );
    case "waiting":
      return (
        <PageBand tone="waiting" icon={<ShieldQuestion size="md" />} label={copy.waiting} detail={copy.payStep}
          actions={<ButtonContainer size="xs"><Button size="xs" variant="outline" text={copy.review} />{stop}</ButtonContainer>} />
      );
    case "need-you":
      return (
        <PageBand tone="warning" icon={<Key size="md" />} label={copy.needYou} detail={copy.keypad}
          actions={<ButtonContainer size="xs"><Button size="xs" text={copy.takeOver} />{stop}</ButtonContainer>} />
      );
    case "pick":
      return (
        <PageBand tone="pick" icon={<Pick size="md" />} label={copy.pickMode} detail={copy.dragToChat} hint={copy.pickHint}
          actions={<ButtonContainer size="xs"><Button size="xs" variant="outline" text={copy.finish} /></ButtonContainer>} />
      );
    case "popup":
      return (
        <PageBand tone="info" icon={<Popup size="md" />} label={copy.popupBlocked} detail={copy.popupHost}
          actions={(
            <>
              <ButtonContainer size="xs"><Button size="xs" variant="outline" text={copy.allow} /></ButtonContainer>
              <IconButton label={copy.clear}><X size="sm" /></IconButton>
            </>
          )} />
      );
  }
}

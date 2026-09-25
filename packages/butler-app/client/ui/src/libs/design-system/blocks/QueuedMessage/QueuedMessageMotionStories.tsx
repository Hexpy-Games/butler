import { useEffect, useRef, useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { clearSendOrigin, recordSendOrigin } from "../../lib/sendFlight";
import { useEnteringKeys } from "../../lib/useEnteringKeys";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerSendButton,
} from "../ComposerCard";
import { MessageRow } from "../MessageRow";
import { queuedShowcaseCopy } from "./QueuedMessage.showcaseCopy";
import { ShowcaseQueued } from "./QueuedMessageStories";

type Phase = "queued" | "sending" | "delivered";

/**
 * Delivery: the queued bubble resolves into the sent one in place. With
 * `sendNow`, the row first shows "Sending…" after Send now.
 */
export function TransitionStory({ context, sendNow }: { context: ShowcaseRenderContext; sendNow: boolean }) {
  const copy = queuedShowcaseCopy(context);
  const [phase, setPhase] = useState<Phase>("queued");
  const [run, setRun] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const deliver = (delay: number) => { timers.current.push(window.setTimeout(() => setPhase("delivered"), delay)); };
  const replay = () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    setRun((value) => value + 1);
    setPhase("queued");
    if (!sendNow) deliver(700);
  };
  return (
    <Stack gap="md">
      <div>
        <MessageRow role="user">{copy.sent}</MessageRow>
        {phase === "delivered" ? (
          <MessageRow key={`delivered-${run}`} role="user" entering="delivered">{copy.messages[0]}</MessageRow>
        ) : (
          <ShowcaseQueued copy={copy} first status={phase === "sending" ? copy.sending : copy.queued}
            tone={phase === "sending" ? "sending" : "queued"}
            onSendNow={() => { setPhase("sending"); deliver(500); }}>
            {copy.messages[0]}
          </ShowcaseQueued>
        )}
      </div>
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={replay}>{copy.replay}</Button>
      </Inline>
    </Stack>
  );
}

type FlightItem = { id: string; text: string; queued: boolean };

/** The sent bubble flies from the composer text to its place; the fallback is the regular insert. */
export function SendFlightStory({ context }: { context: ShowcaseRenderContext }) {
  const copy = queuedShowcaseCopy(context);
  const [items, setItems] = useState<FlightItem[]>([]);
  const [draft, setDraft] = useState<string>(copy.sent);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const entering = useEnteringKeys(items.map((item) => item.id), "send-flight");
  const send = (mode: "fly" | "queued" | "fallback") => {
    const value = draft.trim() || copy.sent;
    if (mode === "fallback") clearSendOrigin();
    else recordSendOrigin(textareaRef.current);
    setItems((current) => [...current.slice(-3), { id: `sent-${Date.now()}`, text: value, queued: mode === "queued" }]);
  };
  return (
    <Stack gap="md">
      <div data-ds-motion="send-flight-list">
        {items.map((item) => item.queued ? (
          <ShowcaseQueued key={item.id} copy={copy} first status={copy.queued} entering={entering.has(item.id)}>
            {item.text}
          </ShowcaseQueued>
        ) : (
          <MessageRow key={item.id} role="user" entering={entering.has(item.id)}>{item.text}</MessageRow>
        ))}
      </div>
      <ComposerCard onSubmit={(event) => { event.preventDefault(); send("fly"); }}>
        <ComposerCardTextarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} />
        <ComposerCardToolbar>
          <ComposerCardToolbarSpacer />
          <ComposerSendButton aria-label={copy.send} data-ds-motion="send-flight" />
        </ComposerCardToolbar>
      </ComposerCard>
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="send-flight-queued" onClick={() => send("queued")}>
          {copy.sendBusy}
        </Button>
        <Button size="sm" variant="outline" data-ds-motion="send-flight-fallback" onClick={() => send("fallback")}>
          {copy.sendFallback}
        </Button>
      </Inline>
    </Stack>
  );
}

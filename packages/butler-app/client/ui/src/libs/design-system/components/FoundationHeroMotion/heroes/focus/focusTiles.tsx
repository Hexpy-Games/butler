import type { ReactNode } from "react";
import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { MessageRow } from "../../../../blocks/MessageRow";
import { NavRow } from "../../../../blocks/NavRow";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { Folder, MessageSquare, Search } from "../../../Icons";
import { Input } from "../../../Input";
import { SegmentedControl } from "../../../SegmentedControl";
import { Switch } from "../../../Switch";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** An element with the focus ring drawn on it (the poster's resting ring). */
const Ringed = ({ children, stop }: { children: ReactNode; stop?: string }) => (
  <span className={s.ringed}>{children}{stop ? <span className={s.stop}>{stop}</span> : null}</span>
);

/** The message list: one exchange. */
export function Turn({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.turn}>
      <MessageRow role="user">{copy.ask}</MessageRow>
      <MessageRow role="assistant">{copy.reply}</MessageRow>
    </div>
  );
}

/** The composer; live in the route (its text field and Send are stops, the typed text reveals), at rest in the poster. */
export function Composer({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  const field = (
    <ComposerCardEditor>
      <ComposerCardEditable><div /></ComposerCardEditable>
      <ComposerCardPlaceholder><span data-t={live ? "ph" : undefined}>{copy.placeholder}</span></ComposerCardPlaceholder>
      {live ? <span className={s.typed}><R name="typed">{copy.typed}</R></span> : null}
    </ComposerCardEditor>
  );
  const send = <ComposerSendButton aria-label={copy.send} mode="send" />;
  return (
    <ComposerCard>
      <ComposerCardExpandedBody>{live ? <Mark block n="field">{field}</Mark> : field}</ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <ComposerCardToolbarSpacer />
        {live ? <Mark n="send">{send}</Mark> : <Ringed stop="4">{send}</Ringed>}
      </ComposerCardToolbar>
    </ComposerCard>
  );
}

/** Finale: the app shell with its numbered stops, the ring resting on Send. */
export function ShellTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.shell} data-still="">
      <Box border="hairline" padding="sm" radius="panel" surface="raised">
        <div className={s.sidebar}>
          <Ringed stop="1"><NavRow active icon={<MessageSquare size="sm" />} label={copy.chats} /></Ringed>
          <NavRow icon={<Folder size="sm" />} label={copy.projects} />
          <NavRow icon={<Search size="sm" />} label={copy.files} />
        </div>
      </Box>
      <div className={s.main}>
        <Turn copy={copy} />
        <Composer copy={copy} />
      </div>
    </div>
  );
}

/** Finale: Tabs as one stop, the ring on the active tab. */
export function TabsTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.tabsTile}>
      <Tabs defaultValue="summary">
        <TabsList aria-label={copy.summary}>
          <Ringed><TabsTrigger value="summary">{copy.summary}</TabsTrigger></Ringed>
          <TabsTrigger value="files">{copy.filesTab}</TabsTrigger>
          <TabsTrigger value="activity">{copy.activity}</TabsTrigger>
        </TabsList>
      </Tabs>
      <span className={s.roving}>{copy.roving}</span>
    </div>
  );
}

/** Finale: the short control row, the ring on the Switch. */
export function RowTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.row}>
      <Button text={copy.continue} />
      <Input aria-label={copy.name} readOnly value={copy.name} />
      <Ringed><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></Ringed>
      <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week" options={[{ value: "week", label: copy.week }, { value: "month", label: copy.month }]} />
    </div>
  );
}

/** Finale: the ring close-up. */
export function CloseTile({ copy }: { copy: FocusCopy }) {
  return (
    <span className={s.closeTarget} data-still="">
      <Ringed><Button text={copy.continue} /></Ringed>
      <span className={s.note} data-place="top">--focus-ring-width 2</span>
      <span className={s.note} data-place="bottom"><span className={s.swatch} />--focus-ring-color</span>
    </span>
  );
}

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
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

/** A numbered stop (no ring). */
const Stop = ({ children, n, block = false, inset = false }: { children: ReactNode; n: string; block?: boolean; inset?: boolean }) => (
  <span className={s.stopped} data-block={block ? "" : undefined}>{children}<span className={s.stop} data-inset={inset ? "" : undefined} data-stop={n}>{n}</span></span>
);

/** Layout-space centre of `el` inside `root` (offset chain: free of the camera's transform and the tile's zoom). */
function centre(el: HTMLElement, root: HTMLElement) {
  let x = el.offsetWidth / 2;
  let y = el.offsetHeight / 2;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return { x, y };
}

/** The whole route, drawn through the shell's numbered stops in order (down, then across, like the scene). */
function useRoute() {
  const ref = useRef<HTMLDivElement>(null);
  const [d, setD] = useState("");
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const draw = () => {
      const pts = [...root.querySelectorAll<HTMLElement>("[data-stop]")].sort((a, b) => Number(a.dataset.stop) - Number(b.dataset.stop)).map((el) => centre(el, root));
      setD(pts.map((p, k) => (k === 0 ? `M${p.x} ${p.y}` : `V${p.y}H${p.x}`)).join(""));
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);
  return { ref, d };
}

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
export function Composer({ copy, live = false, stops = false }: { copy: FocusCopy; live?: boolean; stops?: boolean }) {
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
      <ComposerCardExpandedBody>{live ? <Mark block n="field">{field}</Mark> : stops ? <Stop block inset n="4">{field}</Stop> : field}</ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <ComposerCardToolbarSpacer />
        {live ? <Mark n="send">{send}</Mark> : <Ringed stop={stops ? "5" : undefined}>{send}</Ringed>}
      </ComposerCardToolbar>
    </ComposerCard>
  );
}

/** Finale: the app shell with the whole route drawn through its numbered stops, the ring resting on Send. */
export function ShellTile({ copy }: { copy: FocusCopy }) {
  const { ref, d } = useRoute();
  return (
    <div className={s.shell} data-still="" data-route="" ref={ref}>
      <svg className={s.route} aria-hidden="true"><path d={d} /></svg>
      <Box border="hairline" padding="sm" radius="panel" surface="raised">
        <div className={s.sidebar}>
          <Stop block n="1"><NavRow active icon={<MessageSquare size="sm" />} label={copy.chats} /></Stop>
          <Stop block n="2"><NavRow icon={<Folder size="sm" />} label={copy.projects} /></Stop>
          <Stop block n="3"><NavRow icon={<Search size="sm" />} label={copy.files} /></Stop>
        </div>
      </Box>
      <div className={s.main}>
        <Turn copy={copy} />
        <Composer copy={copy} stops />
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
    <span className={s.closeTile} data-still="">
      <span className={s.tileNote}>--focus-ring-width 2</span>
      <Ringed><Button text={copy.continue} /></Ringed>
      <span className={s.tileNote}><span className={s.swatch} />--focus-ring-color</span>
    </span>
  );
}

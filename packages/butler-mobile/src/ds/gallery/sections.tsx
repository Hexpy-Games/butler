import { useEffect, useState } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { useTokens } from "../../design/useTokens";
import { AttachmentTiles, type AttachmentTile } from "../AttachmentTiles";
import { Badge, UnreadDot } from "../Badge";
import { Button, IconButton, type ButtonVariant } from "../Button";
import { ButtonGroup } from "../ButtonGroup";
import { ContextRing } from "../ContextRing";
import { DecisionCard } from "../DecisionCard";
import { Composer } from "../Composer";
import { GlassBackdrop } from "../GlassBackdrop";
import { Icon } from "../Icon";
import { icons } from "../icons";
import { ForcedState } from "../internal/press";
import { Markdown } from "../Markdown";
import { ListRow } from "../ListRow";
import { Sheet, SheetPanel } from "../Sheet";
import { Spinner } from "../Spinner";
import { Surface } from "../Surface";
import { Switch } from "../Switch";
import { Text, type TextTone, type TextVariant } from "../Text";
import { TextField } from "../TextField";
import { showToast, ToastView, type ToastTone } from "../Toast";
import { en, ko, long, markdown, sampleImage, type Strings } from "./fixtures";

const noop = () => {};
type Forced = "pressed" | "focused" | null;
const sets: [string, Strings][] = [["en", en], ["ko", ko], ["long", long]];

/** A state name above its sample. `list` lets row content start on the page gutter. */
function Cell({ name, list, children }: { name: string; list?: boolean; children: React.ReactNode }) {
  const t = useTokens();
  const gutter = t.length("--adaptive-page-gutter");
  return (
    <View style={{ gap: t.length("--space-2") }}>
      <View style={{ paddingHorizontal: gutter }}>
        <Text variant="caption" tone="tertiary">{name}</Text>
      </View>
      <View style={{ paddingHorizontal: list ? t.length("--space-sm") : gutter }}>{children}</View>
    </View>
  );
}

function Forcing({ state, children }: { state: Forced; children: React.ReactNode }) {
  return <ForcedState.Provider value={state}>{children}</ForcedState.Provider>;
}

/** Puts a sample over body text so the glass edge fades are visible. */
function Over({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View>
      <Text lines={5}>{`${en.note}. ${long.note}. ${en.sentence}. ${long.sentence}. ${en.note}. ${long.note}.`}</Text>
      <View style={{ marginTop: -t.length("--space-6") }}>{children}</View>
    </View>
  );
}

/** A glass sample floating over body text inside a blur target of a fixed height. */
function Floating({ height, children }: { height: number; children: React.ReactNode }) {
  const t = useTokens();
  const overlay = <View style={{ position: "absolute", left: 0, right: 0, top: t.length("--space-6") }}>{children}</View>;
  return (
    <View style={{ height, overflow: "hidden" }}>
      <GlassBackdrop overlay={overlay}>
        <Text>{`${en.note}. ${long.note}. ${en.sentence}. ${long.sentence}. `.repeat(8)}</Text>
      </GlassBackdrop>
    </View>
  );
}

const variants: TextVariant[] = ["h1", "h2", "h3", "h4", "h5", "h6", "body", "caption", "label", "appTitle", "panelTitle", "sectionTitle"];
const tones: TextTone[] = ["primary", "secondary", "tertiary", "disabled", "danger", "success", "warning"];
const states: [string, Forced][] = [["default", null], ["pressed", "pressed"], ["focused", "focused"]];
const buttonVariants: ButtonVariant[] = ["default", "secondary", "outline", "ghost", "destructive"];
const iconTones = ["primary", "secondary", "tertiary", "disabled", "danger", "success", "warning", "accent"] as const;
const iconSizes = ["xs", "sm", "md", "lg", "xl"] as const;
const badgeTones = ["neutral", "accent", "success", "warning", "danger"] as const;
const toastTones: ToastTone[] = ["neutral", "success", "warning", "error"];

function TextSection() {
  return (
    <>
      {variants.map((v) => <Cell key={v} name={v}><Text variant={v}>{en.sentence}</Text></Cell>)}
      {tones.map((tone) => <Cell key={tone} name={`tone ${tone}`}><Text tone={tone}>{en.sentence}</Text></Cell>)}
      <Cell name="lines 1"><Text lines={1}>{long.title}</Text></Cell>
      <Cell name="lines 2"><Text lines={2}>{long.title}</Text></Cell>
      <Cell name="numeric tabular"><Text numeric="tabular">{"1111 0000 8888"}</Text></Cell>
      <Cell name="literal off"><Text>{"/Users/example/shots/2876x6/a->b.png"}</Text></Cell>
      <Cell name="literal on"><Text literal>{"/Users/example/shots/2876x6/a->b.png"}</Text></Cell>
    </>
  );
}

function IconSection() {
  return (
    <>
      {Object.entries(icons).map(([name, glyph]) => (
        <Cell key={name} name={name}><Icon glyph={glyph} /></Cell>
      ))}
      {iconSizes.map((size) => <Cell key={size} name={`size ${size}`}><Icon glyph={icons.Plus} size={size} /></Cell>)}
      {iconTones.map((tone) => <Cell key={tone} name={`tone ${tone}`}><Icon glyph={icons.Plus} tone={tone} /></Cell>)}
    </>
  );
}

function SpinnerSection() {
  return (
    <>
      {[12, 16, 20].map((size) => <Cell key={size} name={`size ${size}`}><Spinner size={size} /></Cell>)}
      <Cell name="in a button"><Button label={en.action} onPress={noop} loading /></Cell>
      <Cell name="with a label"><Spinner label="Loading" /></Cell>
    </>
  );
}

function ButtonSection() {
  const sample = (v: ButtonVariant, name: string, forced: Forced, extra: object = {}) => (
    <Cell key={`${v}-${name}`} name={`${v} · ${name}`}>
      <Forcing state={forced}><View style={{ flexDirection: "row" }}><Button label={en.action} onPress={noop} variant={v} {...extra} /></View></Forcing>
    </Cell>
  );
  return (
    <>
      {buttonVariants.flatMap((v) => [
        ...states.map(([name, forced]) => sample(v, name, forced)),
        sample(v, "disabled", null, { disabled: true }),
        sample(v, "loading", null, { loading: true }),
      ])}
      <Cell name="icon start"><View style={{ flexDirection: "row" }}><Button label={en.action} onPress={noop} iconStart={icons.Plus} /></View></Cell>
      <Cell name="icon end"><View style={{ flexDirection: "row" }}><Button label={en.action} onPress={noop} iconEnd={icons.ChevronRight} /></View></Cell>
      <Cell name="stretch"><Button label={en.action} onPress={noop} stretch /></Cell>
      {states.map(([name, forced]) => (
        <Cell key={name} name={`icon button · ${name}`}>
          <Forcing state={forced}><View style={{ flexDirection: "row" }}><IconButton icon={icons.Plus} label={en.attach} onPress={noop} /></View></Forcing>
        </Cell>
      ))}
      <Cell name="icon button · disabled"><View style={{ flexDirection: "row" }}><IconButton icon={icons.Plus} label={en.attach} onPress={noop} disabled /></View></Cell>
      <Cell name="icon button · loading"><View style={{ flexDirection: "row" }}><IconButton icon={icons.Plus} label={en.attach} onPress={noop} loading /></View></Cell>
      <Cell name="sm"><View style={{ flexDirection: "row", alignItems: "center" }}>
        <IconButton icon={icons.Plus} variant="ghost" size="sm" label={en.attach} onPress={noop} />
        <IconButton icon={icons.Plus} label={en.attach} onPress={noop} />
      </View></Cell>
    </>
  );
}

function ButtonGroupSection() {
  return (
    <>
      <Cell name="stack · 1"><ButtonGroup><Button label={en.action} onPress={noop} /></ButtonGroup></Cell>
      <Cell name="stack · primary, secondary"><ButtonGroup><Button label={en.action} onPress={noop} /><Button label={en.sentence} variant="secondary" onPress={noop} /></ButtonGroup></Cell>
      <Cell name="stack · loading / disabled"><ButtonGroup><Button label={en.action} onPress={noop} loading /><Button label={en.sentence} variant="secondary" onPress={noop} disabled /></ButtonGroup></Cell>
      {sets.map(([name, s]) => (
        <Cell key={name} name={`pair · ${name}`}>
          <ButtonGroup layout="pair"><Button label={s.cancel} variant="secondary" onPress={noop} /><Button label={s.action} onPress={noop} /></ButtonGroup>
        </Cell>
      ))}
    </>
  );
}

function SurfaceSection() {
  const t = useTokens();
  const reserve = t.length("--composer-reserve");
  const body = <Text>{en.sentence}</Text>;
  return (
    <>
      <Cell name="base"><Surface variant="base" padding="md">{body}</Surface></Cell>
      <Cell name="raised"><Surface variant="raised" padding="md">{body}</Surface></Cell>
      <Cell name="card"><Surface variant="card">{body}</Surface></Cell>
      <Cell name="glass"><Floating height={reserve}><Surface variant="glass">{body}</Surface></Floating></Cell>
      <Cell name="glass, no blur target"><Over><Surface variant="glass">{body}</Surface></Over></Cell>
    </>
  );
}

const rowStates: [string, Forced, object][] = [
  ["default", null, {}], ["pressed", "pressed", {}], ["selected", null, { selected: true }],
  ["disabled", null, { disabled: true }], ["focused", "focused", {}],
];

function ListRowSection() {
  return (
    <>
      <Cell name="title only" list><ListRow title={en.sentence} /></Cell>
      <Cell name="disclosure collapsed" list><ListRow icon={icons.Folder} title="Folder" disclosure={{ expanded: false }} onPress={noop} /></Cell>
      <Cell name="disclosure expanded" list><ListRow icon={icons.Folder} title="Folder" disclosure={{ expanded: true }} onPress={noop} /></Cell>
      <Cell name="icon, title, meta" list><ListRow icon={icons.MessageSquare} title={en.sentence} meta={en.meta} /></Cell>
      <Cell name="description, 1 line" list><ListRow title={en.sentence} description={long.note} descriptionLines={1} /></Cell>
      <Cell name="description, 2 lines" list><ListRow title={en.sentence} description={long.note} /></Cell>
      <Cell name="long title, 2 lines" list><ListRow title={long.title} titleLines={2} /></Cell>
      <Cell name="long meta wraps" list><ListRow title={en.sentence} meta={long.meta} /></Cell>
      <Cell name="trailing badge" list><ListRow title={en.sentence} trailing={<Badge label="3" tone="accent" />} /></Cell>
      <Cell name="trailing unread dot" list><ListRow title={en.sentence} trailing={<UnreadDot label="Unread" />} /></Cell>
      <Cell name="trailing spinner" list><ListRow title={en.sentence} trailing={<Spinner />} /></Cell>
      <Cell name="trailing check" list><ListRow title={en.sentence} trailing={<Icon glyph={icons.CheckIcon} tone="accent" />} /></Cell>
      <Cell name="trailing switch" list><ListRow title={en.sentence} description={en.note} trailing={<Switch value label={en.sentence} onValueChange={noop} />} /></Cell>
      {rowStates.map(([name, forced, props]) => (
        <Cell key={name} name={name} list>
          <Forcing state={forced}><ListRow icon={icons.Folder} title={en.sentence} description={en.note} onPress={noop} {...props} /></Forcing>
        </Cell>
      ))}
      {sets.slice(1).map(([name, s]) => (
        <Cell key={name} name={`description and meta · ${name}`} list><ListRow icon={icons.MessageSquare} title={s.sentence} description={s.note} meta={s.meta} /></Cell>
      ))}
    </>
  );
}

function LiveField() {
  const [value, setValue] = useState("");
  return <TextField label={en.message} value={value} onChangeText={setValue} placeholder={en.message} />;
}

function TextFieldSection() {
  const field = (props: Partial<React.ComponentProps<typeof TextField>>) => (
    <TextField label={en.message} value="" onChangeText={noop} {...props} />
  );
  return (
    <>
      <Cell name="empty with placeholder">{field({ placeholder: "name@example.com" })}</Cell>
      <Cell name="filled">{field({ value: en.sentence })}</Cell>
      <Cell name="focused"><Forcing state="focused">{field({ value: en.sentence })}</Forcing></Cell>
      <Cell name="error">{field({ value: en.sentence, error: en.error })}</Cell>
      <Cell name="disabled">{field({ value: en.sentence, disabled: true })}</Cell>
      <Cell name="with description">{field({ description: en.note })}</Cell>
      <Cell name="address, literal">{field({ value: "192.0.2.7:18765", literal: true, keyboardType: "url" })}</Cell>
      <Cell name="code, numeric">{field({ value: "1234 5678", numeric: "tabular", keyboardType: "number-pad" })}</Cell>
      {sets.slice(1).map(([name, s]) => <Cell key={name} name={`error · ${name}`}>{field({ label: s.message, value: s.sentence, error: s.error })}</Cell>)}
      <Cell name="Live"><LiveField /></Cell>
    </>
  );
}

function LiveSwitch() {
  const [value, setValue] = useState(false);
  return <Switch value={value} onValueChange={setValue} label={en.sentence} />;
}

function SwitchSection() {
  const flex = (node: React.ReactNode) => <View style={{ flexDirection: "row" }}>{node}</View>;
  return (
    <>
      <Cell name="off">{flex(<Switch value={false} onValueChange={noop} label="off" />)}</Cell>
      <Cell name="on">{flex(<Switch value onValueChange={noop} label="on" />)}</Cell>
      <Cell name="disabled off">{flex(<Switch value={false} onValueChange={noop} label="off" disabled />)}</Cell>
      <Cell name="disabled on">{flex(<Switch value onValueChange={noop} label="on" disabled />)}</Cell>
      <Cell name="focused"><Forcing state="focused">{flex(<Switch value onValueChange={noop} label="on" />)}</Forcing></Cell>
      <Cell name="in a list row" list><ListRow title={en.sentence} description={en.note} trailing={<Switch value onValueChange={noop} label={en.sentence} />} /></Cell>
      <Cell name="Live">{flex(<LiveSwitch />)}</Cell>
    </>
  );
}

function BadgeSection() {
  return (
    <>
      {badgeTones.map((tone) => <Cell key={tone} name={tone}><Badge label={en.action} tone={tone} /></Cell>)}
      <Cell name="with icon"><Badge label={en.action} tone="success" icon={icons.CheckCircle2} /></Cell>
      <Cell name="long label"><Badge label={long.title} /></Cell>
      <Cell name="unread dot"><View style={{ flexDirection: "row" }}><UnreadDot label="Unread" /></View></Cell>
    </>
  );
}

function LiveComposer() {
  const [value, setValue] = useState("");
  return (
    <Composer value={value} onChangeText={setValue} placeholder={en.message} canSend={value.length > 0} onSend={() => setValue("")}
      sendLabel={en.send} stopLabel={en.stop} attach={{ label: en.attach, onPress: noop }} />
  );
}

function ComposerSection() {
  const { height } = useWindowDimensions();
  const base = { onChangeText: noop, placeholder: en.message, onSend: noop, sendLabel: en.send, stopLabel: en.stop };
  const cell = (name: string, props: Partial<React.ComponentProps<typeof Composer>>, forced: Forced = null) => (
    <Cell key={name} name={name}><Floating height={height}><Forcing state={forced}><Composer {...base} value="" canSend={false} {...props} /></Forcing></Floating></Cell>
  );
  return (
    <>
      {cell("empty", {})}
      {cell("with text", { value: en.sentence, canSend: true })}
      {cell("8+ lines", { value: Array.from({ length: 10 }, (_, i) => `${en.sentence} ${i + 1}`).join("\n"), canSend: true })}
      {cell("stop", { mode: "stop", canSend: true })}
      {cell("busy", { value: en.sentence, busy: true })}
      {cell("disabled", { value: en.sentence, disabled: true, canSend: true })}
      {cell("with attach", { attach: { label: en.attach, onPress: noop } })}
      {cell("with controls", { leading: <Button variant="ghost" label="GPT-6 Sol · Low" onPress={noop} />,
        trailing: <ContextRing ratio={0.5} label="50% used" onPress={noop} />,
        attachments: <AttachmentTiles layout="row" items={[{ key: "file", name: "Photo.png", kind: "file", extension: "PNG" }]}
          onRemove={noop} removeLabel={name => `Remove ${name}`} uploadingLabel="Uploading" failedLabel="Upload failed" /> })}
      {cell("with adjunct", { adjunct: <Text tone="secondary">{en.note}</Text> })}
      {cell("send pressed", { value: en.sentence, canSend: true }, "pressed")}
      <Cell name="Live"><Floating height={height}><LiveComposer /></Floating></Cell>
    </>
  );
}

function AttachmentTilesSection() {
  const items: AttachmentTile[] = [
    { key: "image", name: "Photo.png", kind: "image", image: { uri: sampleImage }, extension: "PNG" },
    { key: "file", name: "Document.pdf", kind: "file", extension: "PDF", meta: "128 KB" },
  ];
  return <>
    <Text variant="caption" tone="secondary">Tile radius 16: concentric with the composer (28 − 12); approved exception to the 28 container radius.</Text>
    <Cell name="row"><AttachmentTiles layout="row" items={[...items,
      { ...items[0], key: "uploading", upload: "uploading" }, { ...items[1], key: "failed", upload: "failed" },
    ]} onRemove={noop} removeLabel={name => `Remove ${name}`} uploadingLabel="Uploading" failedLabel="Upload failed" /></Cell>
    <Cell name="wrap"><AttachmentTiles layout="wrap" items={items} uploadingLabel="Uploading" failedLabel="Upload failed" /></Cell>
  </>;
}

function LiveSheet({ initial }: { initial: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <ButtonGroup><Button label={en.sentence} onPress={() => setOpen(true)} /></ButtonGroup>
      <Sheet open={open} onClose={() => setOpen(false)} title={en.sentence} description={en.note} cancelLabel={en.cancel}
        action={<Button label={en.action} onPress={() => setOpen(false)} />}>
        {Array.from({ length: 30 }, (_, i) => <Text key={i}>{`${i + 1}. ${en.note}`}</Text>)}
      </Sheet>
    </>
  );
}

// A real Android sheet opens in a Modal, where nothing can blur: no blur target there.
const Backdrop = Platform.OS === "ios" ? GlassBackdrop : ({ children, overlay }: React.ComponentProps<typeof GlassBackdrop>) => <View>{children}{overlay}</View>;

function SheetSection({ state }: { state?: string }) {
  const panel = (name: string, props: Partial<React.ComponentProps<typeof SheetPanel>>, s: Strings = en) => (
    <Cell key={name} name={name}>
      <Backdrop overlay={<View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><SheetPanel title={s.sentence} cancelLabel={s.cancel} onClose={noop} action={<Button label={s.action} onPress={noop} />} {...props} /></View>}>
        {Array.from({ length: 12 }, (_, i) => <Text key={i}>{`${en.note}. ${long.note}. ${en.sentence}. ${long.sentence}.`}</Text>)}
      </Backdrop>
    </Cell>
  );
  const lines = Array.from({ length: 30 }, (_, i) => <Text key={i}>{`${i + 1}. ${en.note}`}</Text>);
  return (
    <>
      {panel("title only, actions", {})}
      {panel("title, description, body, actions", { description: en.note, children: <Text>{en.note}</Text> })}
      {panel("long scrolling body", { description: en.note, children: lines })}
      {panel("long labels", {}, long)}
      {panel("description, no action", { description: en.note, action: undefined })}
      {panel("ko", { description: ko.note }, ko)}
      <Cell name="Live"><LiveSheet initial={state === "open"} /></Cell>
    </>
  );
}

function ToastSection({ state }: { state?: string }) {
  useEffect(() => {
    if (state === "open") showToast({ message: en.sentence, tone: "success" });
  }, [state]);
  return (
    <>
      {toastTones.map((tone) => <Cell key={tone} name={tone}><ToastView message={en.sentence} tone={tone} /></Cell>)}
      <Cell name="3 lines"><ToastView tone="warning" message={`${en.note}. ${en.note}. ${en.note}. ${en.note}.`} /></Cell>
      {sets.slice(1).map(([name, s]) => <Cell key={name} name={name}><ToastView tone="error" message={s === long ? long.title : s.note} /></Cell>)}
      <Cell name="Live"><ButtonGroup><Button label={en.sentence} onPress={() => showToast({ message: en.sentence })} /></ButtonGroup></Cell>
    </>
  );
}

function DecisionCardSection() {
  return <>
    <Cell name="approval"><DecisionCard eyebrow="Permission" title="Run a command?" tag={{ label: "High risk", tone: "danger" }}
      actions={<ButtonGroup layout="pair"><Button label="Deny" variant="secondary" onPress={noop} /><Button label="Allow once" onPress={noop} /></ButtonGroup>}>
      <Markdown text={"```\npwd\n```"} />
    </DecisionCard></Cell>
    <Cell name="handoff"><DecisionCard eyebrow="Browser" title="Sign-in needs you"
      actions={<ButtonGroup><Button label="Stop task" variant="secondary" onPress={noop} /></ButtonGroup>}>
      <Text>Finish this on your computer</Text>
    </DecisionCard></Cell>
    <Cell name="question"><DecisionCard eyebrow="Destination" title="Where should it go?"
      actions={<ButtonGroup><Button label="Send" onPress={noop} /><Button label="Skip" variant="secondary" onPress={noop} />
        <Button label="Answer later" variant="secondary" onPress={noop} /></ButtonGroup>}>
      <ListRow title="This folder" meta="Recommended" selected onPress={noop} />
      <TextField label="Other…" value="" onChangeText={noop} />
    </DecisionCard></Cell>
  </>;
}

export const sections: { id: string; title: string; render: (state?: string) => React.ReactNode }[] = [
  { id: "decision-card", title: "DecisionCard", render: () => <DecisionCardSection /> },
  { id: "markdown", title: "Markdown", render: () => <Cell name="Markdown"><Markdown text={markdown} /></Cell> },
  { id: "text", title: "Text", render: () => <TextSection /> },
  { id: "icon", title: "Icon", render: () => <IconSection /> },
  { id: "spinner", title: "Spinner", render: () => <SpinnerSection /> },
  { id: "button", title: "Button", render: () => <ButtonSection /> },
  { id: "button-group", title: "ButtonGroup", render: () => <ButtonGroupSection /> },
  { id: "surface", title: "Surface", render: () => <SurfaceSection /> },
  { id: "list-row", title: "ListRow", render: () => <ListRowSection /> },
  { id: "text-field", title: "TextField", render: () => <TextFieldSection /> },
  { id: "switch", title: "Switch", render: () => <SwitchSection /> },
  { id: "badge", title: "Badge", render: () => <BadgeSection /> },
  { id: "context-ring", title: "ContextRing", render: () => <>{[0.05, 0.5, 0.95].map(ratio =>
    <Cell key={ratio} name={String(ratio)}><ContextRing ratio={ratio} label={`${ratio * 100}% used`} onPress={noop} /></Cell>)}</> },
  { id: "attachment-tiles", title: "AttachmentTiles", render: () => <AttachmentTilesSection /> },
  { id: "composer", title: "Composer", render: () => <ComposerSection /> },
  { id: "sheet", title: "Sheet", render: (state) => <SheetSection state={state} /> },
  { id: "toast", title: "Toast", render: (state) => <ToastSection state={state} /> },
];

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "../../../../blocks/AdaptiveShell";
import {
  ComposerCard, ComposerCardExpandedBody, ComposerCardExpandedControls, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton,
  ComposerCardEditable, ComposerCardEditor, ComposerCardPlaceholder,
} from "../../../../blocks/ComposerCard";
import { ComposerControl } from "../../../../blocks/ComposerControl";
import { MessageRow } from "../../../../blocks/MessageRow";
import { NavRow } from "../../../../blocks/NavRow";
import { NavSectionHeading } from "../../../../blocks/NavSection";
import { SidebarBrand, SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { IconButton } from "../../../IconButton";
import { Activity, AiChip, Clock3, ListFilter, MessageSquare, PanelLeft, PencilLine, Plus, Search, Settings, ShieldQuestion } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import { Typo } from "../../../Typo";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/**
 * Names elements inside a DS component as marks (`data-a`) without wrapping
 * them (a wrapper would change a stretched tab list): `names` maps a mark to
 * a selector inside the children. Set before the hero measures (child layout
 * effects run first).
 */
export function Named({ names, children }: { names: Record<string, string>; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    for (const [name, selector] of Object.entries(names)) ref.current?.querySelector(selector)?.setAttribute("data-a", name);
  }, [names]);
  return <span className={s.named} ref={ref}>{children}</span>;
}

const TAB_NAMES = { "tab-all": '[role="tab"][data-state="active"]' };

/** The sidebar's view tabs (the app's own), one instance per selected view: the hero cuts between them as arrows move the selection. */
function ViewTabs({ copy, live }: { copy: FocusCopy; live: boolean }) {
  const views = [["all", copy.all, <ListFilter key="i" />], ["recent", copy.recent, <Clock3 key="i" />], ["running", copy.running, <Activity key="i" />]] as const;
  const one = (value: string) => (
    <Tabs value={value}>
      <TabsList aria-label={copy.views} stretch>
        {views.map(([id, label, icon]) => <TabsTrigger key={id} value={id}>{icon}{label}</TabsTrigger>)}
      </TabsList>
    </Tabs>
  );
  if (!live) return one("all");
  return (
    <span className={s.stackedTabs}>
      <span data-t="vt-all"><Named names={TAB_NAMES}>{one("all")}</Named></span>
      <span data-t="vt-recent"><Named names={{ "tab-recent": '[role="tab"][data-state="active"]' }}>{one("recent")}</Named></span>
    </span>
  );
}

/** The app's sidebar: brand, New chat and Search, favourites, the view tabs, the open conversation, Settings. */
function Sidebar({ copy, live }: { copy: FocusCopy; live: boolean }) {
  const mark = (n: string, row: ReactNode) => (live ? <Mark block n={n}>{row}</Mark> : row);
  return (
    <SidebarShell
      ariaLabel={copy.app}
      footer={mark("set", <NavRow icon={<Settings />} label={copy.settings} />)}
      scrollHeader={
        <Stack gap="xl">
          <SidebarNav ariaLabel={copy.app}>
            {mark("nav0", <NavRow icon={<PencilLine />} label={copy.newChat} />)}
            {mark("nav1", <NavRow icon={<Search />} label={copy.search} />)}
          </SidebarNav>
        </Stack>
      }
      stickyHeader={<Stack gap="sm"><ViewTabs copy={copy} live={live} /><NavSectionHeading title={copy.recent} /></Stack>}
      titlebar={<SidebarBrand><Typo.AppTitle>{copy.app}</Typo.AppTitle></SidebarBrand>}
    >
      {mark("chat", <NavRow active icon={<MessageSquare />} label={copy.chat} meta={copy.chatMeta} />)}
    </SidebarShell>
  );
}

/** The conversation: one exchange. */
export function Turn({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.turn}>
      <MessageRow role="user">{copy.ask}</MessageRow>
      <MessageRow role="assistant">{copy.reply}</MessageRow>
    </div>
  );
}

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
    <ComposerCard>
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
      <ComposerCardToolbar>
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
      </ComposerCardToolbar>
    </ComposerCard>
  );
}

/** The workspace: the conversation's titlebar, the exchange, the composer at the foot. */
function Workspace({ copy, live, leading }: { copy: FocusCopy; live: boolean; leading?: ReactNode }) {
  return (
    <>
      <TitlebarShell dataTestClass="custom-titlebar" leading={leading} title={copy.chat} />
      <div className={s.conversation}>
        <Turn copy={copy} />
        <div className={s.composerSlot}><Composer copy={copy} live={live} /></div>
      </div>
    </>
  );
}

/** The expanded app window (wide): the real AdaptiveShell, sidebar docked beside the workspace. */
export function WideShell({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  return (
    <div className={s.window} data-shell="wide">
      <AdaptiveShell chromeEnvironment="electron" leftOpen platform="darwin" rightOpen={false}>
        <AdaptiveShellSidebar open><Sidebar copy={copy} live={live} /></AdaptiveShellSidebar>
        <AdaptiveShellWorkspace><Workspace copy={copy} live={live} /></AdaptiveShellWorkspace>
      </AdaptiveShell>
    </div>
  );
}

/** The compact app screen (tall): the sidebar folded into its drawer, the titlebar's toggle leading. */
export function CompactShell({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  const toggle = <IconButton label={copy.app}><PanelLeft size="md" /></IconButton>;
  return (
    <div className={s.window} data-shell="compact">
      <AdaptiveShell chromeEnvironment="electron" leftOpen={false} platform="darwin" rightOpen={false}>
        <AdaptiveShellWorkspace><Workspace copy={copy} leading={live ? <Mark n="toggle">{toggle}</Mark> : toggle} live={live} /></AdaptiveShellWorkspace>
      </AdaptiveShell>
    </div>
  );
}

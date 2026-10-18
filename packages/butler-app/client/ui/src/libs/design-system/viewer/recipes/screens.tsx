// "Build a screen" recipes: real Butler screens assembled only from DS pieces.
// The viewer shows each recipe's JSX verbatim from its #region block, so the
// code on the page is exactly what renders above it.
import { ActivityHeatmap } from "../../blocks/ActivityHeatmap";
import { CollapsibleNavGroup } from "../../blocks/CollapsibleNavGroup";
import {
  ComposerCard, ComposerCardTextarea, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton,
} from "../../blocks/ComposerCard";
import { DashboardHeader } from "../../blocks/DashboardHeader";
import { DialogForm } from "../../blocks/DialogForm";
import { DocumentTile } from "../../blocks/DocumentTile";
import { EmptyLine } from "../../blocks/EmptyLine";
import { MarkdownContent } from "../../blocks/MarkdownContent";
import { MessageFooter, MessageRow } from "../../blocks/MessageRow";
import { MetricCard } from "../../blocks/MetricCard";
import { MetricGrid } from "../../blocks/MetricGrid";
import { NavRow, NavRowSwap } from "../../blocks/NavRow";
import { NavSectionHeading } from "../../blocks/NavSection";
import { Notice } from "../../blocks/Notice";
import { OverflowActionMenu } from "../../blocks/OverflowActionMenu";
import { SettingsField } from "../../blocks/SettingsField";
import { SettingsHeader } from "../../blocks/SettingsHeader";
import { SettingsPage, SettingsSection } from "../../blocks/SettingsSection";
import { SidebarNav, SidebarShell, SidebarTrafficSpace } from "../../blocks/SidebarShell";
import { WorkActivityBlock } from "../../blocks/WorkActivityBlock";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { CopyButton } from "../../components/CopyButton";
import { IconButton } from "../../components/IconButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/DropdownMenu";
import { IconSlot } from "../../components/IconSlot";
import {
  Activity, Archive, Briefcase, ChevronDown, Clock3, FileText, Folder, FolderPlus, GeneralChat, LayoutDashboard, ListFilter,
  MessageSquare, MessageSquarePlus, Notebook, PencilLine, Plus, Search, Settings, Terminal,
} from "../../components/Icons";
import { Input } from "../../components/Input";
import { PageContainer } from "../../components/PageContainer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { Stack } from "../../components/Stack";
import { Switch } from "../../components/Switch";
import { Tabs, TabsList, TabsTrigger } from "../../components/Tabs";

// #region recipe: Settings page
export function SettingsPageRecipe() {
  return (
    <PageContainer width="narrow" align="start">
      <Stack gap="2xl">
        <SettingsHeader title="General" description="Language, appearance and notifications." />
        <SettingsPage>
          <SettingsSection id="appearance" kind="form" title="Appearance" description="Applies to every window.">
            <SettingsField id="theme" label="Theme" control={(
              <Select defaultValue="system">
                <SelectTrigger id="theme"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            )} />
            <SettingsField id="translucent" label="Translucent sidebar" description="Show the desktop behind the sidebar."
              control={<Switch id="translucent" defaultChecked />} />
          </SettingsSection>
          <SettingsSection id="profile" kind="form" title="Profile">
            <SettingsField id="name" label="Display name" control={<Input id="name" defaultValue="Butler" />} />
          </SettingsSection>
        </SettingsPage>
      </Stack>
    </PageContainer>
  );
}
// #endregion

// #region recipe: Conversation turn
export function ConversationTurnRecipe() {
  return (
    <Stack gap="lg">
      <MessageRow role="user">Summarize what changed in the settings pages.</MessageRow>
      <MessageRow role="assistant">
        <WorkActivityBlock title="Reading the settings pages" connected tools={[
          { id: "search", icon: <Search size="md" />, title: "Search: SettingsSection", summaryLabel: "Search" },
          { id: "bash", icon: <Terminal size="md" />, title: "Bash: bun run app:layout:smoke", summaryLabel: "Bash" },
        ]} />
        <MarkdownContent>
          <p>Section headers now sit above their cards, and every field follows one spacing ramp.</p>
        </MarkdownContent>
        <MessageFooter>
          <CopyButton text="Section headers now sit above their cards." label="Copy message" copiedLabel="Copied" />
        </MessageFooter>
      </MessageRow>
      <ComposerCard onSubmit={(event) => event.preventDefault()}>
        <ComposerCardTextarea aria-label="Message" placeholder="Ask for follow-up changes" rows={1} />
        <ComposerCardToolbar>
          <IconButton label="More options"><Plus size="md" /></IconButton>
          <ComposerCardToolbarSpacer />
          <ComposerSendButton aria-label="Send" />
        </ComposerCardToolbar>
      </ComposerCard>
    </Stack>
  );
}
// #endregion

// #region recipe: Sidebar
/** SpaceRowMenu: the row's rest status gives way to its menu on hover and focus. */
function RowMenu({ title }: { title: string }) {
  return (
    <NavRowSwap>
      <OverflowActionMenu label={`${title} menu`} items={[
        { icon: <PencilLine size="sm" />, label: "Rename", onSelect: () => undefined },
        { icon: <Archive size="sm" />, label: "Archive", onSelect: () => undefined },
      ]} />
    </NavRowSwap>
  );
}

/** SpaceRowActions: a project's dashboard, then the folder chevron that gives way to the row menu. */
function FolderActions({ title, project = false }: { title: string; project?: boolean }) {
  return (
    <ButtonContainer size="icon-sm" wrap={false}>
      {project ? <IconButton label={`${title} dashboard`}><LayoutDashboard /></IconButton> : null}
      <NavRowSwap rest={<IconButton tabIndex={-1} label={`${title} collapse`}><ChevronDown /></IconButton>}>
        <RowMenu title={title} />
      </NavRowSwap>
    </ButtonContainer>
  );
}

/** SpaceBrowseHeader: the view tabs, the General chat, then the Space heading and its actions; it sticks. */
function SpaceBrowseHeader() {
  return (
    <Stack gap="sm">
      <Stack gap="md">
        <Tabs defaultValue="all">
          <TabsList stretch aria-label="Views">
            <TabsTrigger value="all"><ListFilter />All</TabsTrigger>
            <TabsTrigger value="recent"><Clock3 />Recent</TabsTrigger>
            <TabsTrigger value="running"><Activity />Running</TabsTrigger>
          </TabsList>
        </Tabs>
        <NavRow icon={<IconSlot size="sidebar"><GeneralChat /></IconSlot>} label="General" active onClick={() => undefined}
          actions={<RowMenu title="General" />} />
      </Stack>
      <NavSectionHeading title="Space" actions={(
        <ButtonContainer size="icon-sm">
          <IconButton label="New chat"><IconSlot size="sm"><PencilLine /></IconSlot></IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Space menu"><IconSlot size="sm"><FolderPlus /></IconSlot></IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8}>
              <DropdownMenuItem>New group</DropdownMenuItem>
              <DropdownMenuItem>New project</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonContainer>
      )} />
    </Stack>
  );
}

export function SidebarRecipe() {
  return (
    <SidebarShell ariaLabel="Sidebar" titlebar={<SidebarTrafficSpace />} stickyHeader={<SpaceBrowseHeader />}
      scrollHeader={(
        <SidebarNav ariaLabel="Primary actions">
          <NavRow icon={<PencilLine />} label="New chat" onClick={() => undefined} />
          <NavRow icon={<Search />} label="Search" onClick={() => undefined} />
          <NavRow icon={<IconSlot size="sidebar" minHeight="line"><Clock3 /></IconSlot>} label="Schedules" onClick={() => undefined} />
        </SidebarNav>
      )}
      footer={<SidebarNav ariaLabel="Footer"><NavRow icon={<Settings />} label="Settings" onClick={() => undefined} /></SidebarNav>}>
      <CollapsibleNavGroup indented stickyDepth={0} expanded icon={<IconSlot size="sidebar"><Briefcase /></IconSlot>} label="butler"
        onToggle={() => undefined} actions={<FolderActions title="butler" project />}>
        <NavRow icon={<IconSlot size="sidebar"><Notebook /></IconSlot>} label="Token page review" onClick={() => undefined}
          actions={<RowMenu title="Token page review" />} />
        <NavRow icon={<IconSlot size="sidebar"><Notebook /></IconSlot>} label="Settings S7" onClick={() => undefined}
          actions={<RowMenu title="Settings S7" />} />
      </CollapsibleNavGroup>
      <CollapsibleNavGroup indented stickyDepth={0} expanded={false} icon={<IconSlot size="sidebar"><Folder /></IconSlot>} label="Reading"
        onToggle={() => undefined} actions={<FolderActions title="Reading" />}>
        <NavRow icon={<IconSlot size="sidebar"><MessageSquare /></IconSlot>} label="Weekly review" onClick={() => undefined}
          actions={<RowMenu title="Weekly review" />} />
      </CollapsibleNavGroup>
      <NavRow icon={<IconSlot size="sidebar"><MessageSquare /></IconSlot>} label="Travel plan" onClick={() => undefined}
        actions={<RowMenu title="Travel plan" />} />
    </SidebarShell>
  );
}
// #endregion

// #region recipe: Project dashboard
export function DashboardRecipe() {
  return (
    <Stack gap="2xl">
      <DashboardHeader title="butler" action={(
        <Button variant="outline"><MessageSquarePlus size="md" /> New chat</Button>
      )} />
      <MetricGrid>
        <MetricCard label="Open work" value={12} />
        <MetricCard label="Done this week" value={31} trend="up" change="+8" />
        <MetricCard label="Conversations" value={46} />
      </MetricGrid>
      <ActivityHeatmap ariaLabel="Recent activity" startWeekday={1} days={Array.from({ length: 28 }, (_, index) => (
        { id: `day-${index}`, label: `Day ${index + 1}`, count: (index * 5) % 9 }
      ))} />
      <Stack gap="xs">
        <DocumentTile badge="Plan" icon={<FileText size="md" />} title="Settings hierarchy rollout" meta="In review" actionLabel="Open" onOpen={() => undefined} />
        <DocumentTile icon={<FileText size="md" />} title="Design-system spec" meta="specs/design-system.md" actionLabel="Open" onOpen={() => undefined} />
      </Stack>
    </Stack>
  );
}
// #endregion

// #region recipe: Dialog form
export function DialogFormRecipe() {
  return (
    <DialogForm title="New project" description="Name the project and pick its folder." onSubmit={() => undefined}
      footer={(
        <ButtonContainer size="default" justify="end">
          <Button type="button" variant="outline">Cancel</Button>
          <Button type="submit">Create</Button>
        </ButtonContainer>
      )}>
      <SettingsField id="project-name" label="Project name" control={<Input id="project-name" defaultValue="butler-site" />} />
    </DialogForm>
  );
}
// #endregion

// #region recipe: Empty, loading and error states
export function StatesRecipe() {
  return (
    <Stack gap="xl">
      <EmptyLine message="No automations yet." action={<Button size="sm" variant="outline" iconStart={<Plus size="md" />} text="New automation" />} />
      <Stack gap="sm" aria-busy="true">
        <Skeleton label="Loading settings" height="title" width="2/5" />
        <Skeleton height="row" width="full" />
      </Stack>
      <Notice tone="error" title="Could not load the dashboard" message="Check the connection and try again."
        action={<Button variant="outline" text="Retry" />} />
    </Stack>
  );
}
// #endregion

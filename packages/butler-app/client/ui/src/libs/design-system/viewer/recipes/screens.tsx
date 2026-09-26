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
import { FormSection } from "../../blocks/FormSection";
import { MarkdownContent } from "../../blocks/MarkdownContent";
import { MessageFooter, MessageRow } from "../../blocks/MessageRow";
import { MetricCard } from "../../blocks/MetricCard";
import { MetricGrid } from "../../blocks/MetricGrid";
import { NavRow } from "../../blocks/NavRow";
import { NavSection } from "../../blocks/NavSection";
import { Notice } from "../../blocks/Notice";
import { OverflowActionMenu } from "../../blocks/OverflowActionMenu";
import { SettingsField } from "../../blocks/SettingsField";
import { SettingsHeader } from "../../blocks/SettingsHeader";
import { WorkActivityBlock } from "../../blocks/WorkActivityBlock";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { CopyButton } from "../../components/CopyButton";
import { IconButton } from "../../components/IconButton";
import {
  Archive, FileText, Folder, FolderOpen, GeneralChat, MessageSquarePlus, PencilLine, Plus, Search, Terminal,
} from "../../components/Icons";
import { Input } from "../../components/Input";
import { PageContainer } from "../../components/PageContainer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { Stack } from "../../components/Stack";
import { Switch } from "../../components/Switch";

// #region recipe: Settings page
export function SettingsPageRecipe() {
  return (
    <PageContainer width="narrow" align="start">
      <Stack gap="2xl">
        <SettingsHeader title="General" description="Language, appearance and notifications." />
        <FormSection title="Appearance" description="Applies to every window.">
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
        </FormSection>
        <FormSection title="Profile">
          <SettingsField id="name" label="Display name" control={<Input id="name" defaultValue="Butler" />} />
        </FormSection>
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
export function SidebarRecipe() {
  return (
    <Stack gap="lg">
      <NavSection title="Chats">
        <NavRow icon={<GeneralChat size="md" />} label="General" active onClick={() => undefined} />
      </NavSection>
      <NavSection title="Projects" actions={<IconButton label="New project"><Plus size="md" /></IconButton>}>
        <CollapsibleNavGroup expanded icon={<FolderOpen size="md" />} label="butler" onToggle={() => undefined}>
          <NavRow label="Token page review" onClick={() => undefined} actionsVisibility="hover" actions={(
            <OverflowActionMenu label="Session actions" items={[
              { icon: <PencilLine size="sm" />, label: "Rename", onSelect: () => undefined },
              { icon: <Archive size="sm" />, label: "Archive", onSelect: () => undefined },
            ]} />
          )} />
          <NavRow label="Settings S7" onClick={() => undefined} />
        </CollapsibleNavGroup>
        <CollapsibleNavGroup expanded={false} icon={<Folder size="md" />} label="butler-site" onToggle={() => undefined}>
          <NavRow label="Landing copy" />
        </CollapsibleNavGroup>
      </NavSection>
    </Stack>
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
        <Skeleton label="Loading settings" style={{ height: 18, width: "40%" }} />
        <Skeleton style={{ height: 44, width: "100%" }} />
      </Stack>
      <Notice tone="error" title="Could not load the dashboard" message="Check the connection and try again."
        action={<Button variant="outline" text="Retry" />} />
    </Stack>
  );
}
// #endregion

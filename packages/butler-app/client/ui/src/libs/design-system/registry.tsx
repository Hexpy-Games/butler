import type { ReactNode } from "react";
import { Bar, BarChart, XAxis } from "recharts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  ButtonContainer,
  ChartContainer,
  Clickable,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Grid,
  IconButton,
  Input,
  Label,
  NativeSelect,
  PillButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Section,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Space,
  Stack,
  Switch,
  Textarea,
  Tooltip,
  Typo,
  Folder,
  Plus,
  Search,
} from "./index";

// Import block fixtures
import { AdaptiveShellFixture } from "./blocks/AdaptiveShell/AdaptiveShell.fixtures";
import { NavRowFixture } from "./blocks/NavRow/NavRow.fixtures";
import { ButtonContainerFixture } from "./components/ButtonContainer/ButtonContainer.fixtures";
import { NavSectionFixture } from "./blocks/NavSection/NavSection.fixtures";
import { CollapsibleNavGroupFixture } from "./blocks/CollapsibleNavGroup/CollapsibleNavGroup.fixtures";
import { RowActionClusterFixture } from "./blocks/RowActionCluster/RowActionCluster.fixtures";
import { OverflowActionMenuFixture } from "./blocks/OverflowActionMenu/OverflowActionMenu.fixtures";
import { FormRowFixture } from "./blocks/FormRow/FormRow.fixtures";
import { FormSectionFixture } from "./blocks/FormSection/FormSection.fixtures";
import { PanelHeaderFixture } from "./blocks/PanelHeader/PanelHeader.fixtures";
import { PromptSuggestionListFixture } from "./blocks/PromptSuggestionList/PromptSuggestionList.fixtures";
import { SurfacePanelFixture } from "./blocks/SurfacePanel/SurfacePanel.fixtures";
import { MetricCardFixture } from "./blocks/MetricCard/MetricCard.fixtures";
import { MetricGridFixture } from "./blocks/MetricGrid/MetricGrid.fixtures";
import { CardListFixture } from "./blocks/CardList/CardList.fixtures";
import { SortableCardListFixture } from "./blocks/SortableCardList/SortableCardList.fixtures";
import { ListRowFixture } from "./blocks/ListRow/ListRow.fixtures";
import { ResourceSummaryFixture } from "./blocks/ResourceSummary/ResourceSummary.fixtures";
import { ResourceTileFixture } from "./blocks/ResourceTile/ResourceTile.fixtures";
import { EmptyLineFixture } from "./blocks/EmptyLine/EmptyLine.fixtures";
import { NoticeFixture } from "./blocks/Notice/Notice.fixtures";
import { ConversationShellFixture } from "./blocks/ConversationShell/ConversationShell.fixtures";
import { ComposerControlFixture } from "./blocks/ComposerControl/ComposerControl.fixtures";
import { OptionMenuFixture } from "./blocks/OptionMenu/OptionMenu.fixtures";
import { FilteredSelectPopoverFixture } from "./blocks/FilteredSelectPopover/FilteredSelectPopover.fixtures";
import { ContextDonutButtonFixture } from "./blocks/ContextDonutButton/ContextDonutButton.fixtures";
import { ComposerCardFixture } from "./blocks/ComposerCard/ComposerCard.fixtures";
import { ComposerAdjunctPanelFixture } from "./blocks/ComposerAdjunctPanel/ComposerAdjunctPanel.fixtures";
import { ComposerQueuePanelFixture } from "./blocks/ComposerQueuePanel/ComposerQueuePanel.fixtures";
import { AttachmentListFixture } from "./blocks/AttachmentList/AttachmentList.fixtures";
import { MessageRowFixture } from "./blocks/MessageRow/MessageRow.fixtures";
import { MessageAvatarBlockFixture } from "./blocks/MessageAvatarBlock/MessageAvatarBlock.fixtures";
import { ActivityFeedFixture } from "./blocks/ActivityFeed/ActivityFeed.fixtures";
import { WorkActivityBlockFixture } from "./blocks/WorkActivityBlock/WorkActivityBlock.fixtures";
import { DisclosureRowFixture } from "./blocks/DisclosureRow/DisclosureRow.fixtures";
import { InspectorPanelFixture } from "./blocks/InspectorPanel/InspectorPanel.fixtures";
import { InspectorShellFixture } from "./blocks/InspectorShell/InspectorShell.fixtures";
import { KeyValueRowFixture } from "./blocks/KeyValueRow/KeyValueRow.fixtures";
import { ProgressMeterFixture } from "./blocks/ProgressMeter/ProgressMeter.fixtures";
import { ProgressStepperFixture } from "./blocks/ProgressStepper/ProgressStepper.fixtures";
import { SetupWizardShellFixture } from "./blocks/SetupWizardShell/SetupWizardShell.fixtures";
import { TodoProgressPanelFixture } from "./blocks/TodoProgressPanel/TodoProgressPanel.fixtures";
import { WorkerActivityPanelFixture } from "./blocks/WorkerActivityPanel/WorkerActivityPanel.fixtures";
import { WorkerActivityRowFixture } from "./blocks/WorkerActivityRow/WorkerActivityRow.fixtures";
import { SettingsFieldFixture } from "./blocks/SettingsField/SettingsField.fixtures";
import { SettingsHeaderFixture } from "./blocks/SettingsHeader/SettingsHeader.fixtures";
import { SettingsNavFixture } from "./blocks/SettingsNav/SettingsNav.fixtures";
import { SettingsShellFixture } from "./blocks/SettingsShell/SettingsShell.fixtures";
import { SettingsSecretRowsFixture } from "./blocks/SettingsSecretRows/SettingsSecretRows.fixtures";
import { TokenInputControlFixture } from "./blocks/TokenInputControl/TokenInputControl.fixtures";
import { PercentInputControlFixture } from "./blocks/PercentInputControl/PercentInputControl.fixtures";
import { ManagementPageFixture } from "./blocks/ManagementPage/ManagementPage.fixtures";
import { DashboardHeaderFixture } from "./blocks/DashboardHeader/DashboardHeader.fixtures";
import { DocumentTileFixture } from "./blocks/DocumentTile/DocumentTile.fixtures";
import { SessionRowFixture } from "./blocks/SessionRow/SessionRow.fixtures";
import { AutomationRowFixture } from "./blocks/AutomationRow/AutomationRow.fixtures";
import { AutomationRunListFixture } from "./blocks/AutomationRunList/AutomationRunList.fixtures";
import { ActivityHeatmapFixture } from "./blocks/ActivityHeatmap/ActivityHeatmap.fixtures";
import { ArtifactListFixture } from "./blocks/ArtifactList/ArtifactList.fixtures";
import { ArtifactPreviewFixture } from "./blocks/ArtifactPreview/ArtifactPreview.fixtures";
import { MarkdownContentFixture } from "./blocks/MarkdownContent/MarkdownContent.fixtures";
import { ScrollAreaFixture } from "./blocks/ScrollArea/ScrollArea.fixtures";
import { CommandPanelFixture } from "./blocks/CommandPanel/CommandPanel.fixtures";
import { DialogFormFixture } from "./blocks/DialogForm/DialogForm.fixtures";
import { ChromeFrameFixture } from "./blocks/ChromeFrame/ChromeFrame.fixtures";
import { TitlebarShellFixture } from "./blocks/TitlebarShell/TitlebarShell.fixtures";
import { SidebarShellFixture } from "./blocks/SidebarShell/SidebarShell.fixtures";
import { TabsFixture } from "./components/Tabs/Tabs.fixtures";
import { SliderFixture } from "./components/Slider/Slider.fixtures";
import { CardFixture } from "./components/Card/Card.fixtures";
import { TintedGlassFixture } from "./components/TintedGlass/TintedGlass.fixtures";
import { SkeletonFixture } from "./components/Skeleton/Skeleton.fixtures";

export type DesignSystemComponentMeta = {
  name: string;
  path: string;
  tags: string[];
  fixture: () => ReactNode;
};

export type DesignSystemBlockMeta = {
  name: string;
  path: string;
  tags: string[];
  fixture: () => ReactNode;
};

export type DesignSystemTokenGroup = {
  name: string;
  tokens: Array<{
    name: string;
    value: string;
    kind: "color" | "effect" | "space" | "radius" | "type";
  }>;
};

type DesignSystemTokenKind = DesignSystemTokenGroup["tokens"][number]["kind"];

function tokens(names: string[], kind: DesignSystemTokenKind = "color") {
  return names.map((name) => ({ name, value: `var(${name})`, kind }));
}

export const designSystemTokenGroups: DesignSystemTokenGroup[] = [
  {
    name: "Palette / Neutral Source",
    tokens: tokens([
      "--neutral-white",
      "--neutral-light-text-primary",
      "--neutral-light-text-secondary",
      "--neutral-light-text-disabled",
      "--neutral-dark-text-secondary",
      "--neutral-dark-text-tertiary",
      "--neutral-dark-text-disabled",
      "--neutral-dark-icon-muted",
      "--neutral-dark-placeholder",
      "--neutral-dark-send-stop",
    ]),
  },
  {
    name: "Palette / Grayscale",
    tokens: tokens([
      "--grayscale-01",
      "--grayscale-02",
      "--grayscale-03",
      "--grayscale-04",
      "--grayscale-05",
      "--grayscale-06",
      "--grayscale-07",
      "--grayscale-08",
      "--grayscale-09",
      "--grayscale-10",
      "--grayscale-11",
      "--grayscale-12",
    ]),
  },
  {
    name: "Palette / Blue",
    tokens: tokens([
      "--blue-01",
      "--blue-02",
      "--blue-03",
      "--blue-04",
      "--blue-05",
      "--blue-06",
      "--blue-07",
      "--blue-08",
      "--blue-09",
      "--blue-10",
    ]),
  },
  {
    name: "Palette / Green",
    tokens: tokens([
      "--green-01",
      "--green-02",
      "--green-03",
      "--green-04",
      "--green-05",
      "--green-06",
      "--green-07",
      "--green-08",
      "--green-09",
      "--green-10",
      "--green-worker-active",
    ]),
  },
  {
    name: "Palette / Red",
    tokens: tokens([
      "--red-01",
      "--red-02",
      "--red-03",
      "--red-04",
      "--red-05",
      "--red-06",
      "--red-07",
      "--red-08",
      "--red-09",
      "--red-10",
    ]),
  },
  {
    name: "Palette / Amber",
    tokens: tokens([
      "--amber-01",
      "--amber-02",
      "--amber-03",
      "--amber-04",
      "--amber-05",
      "--amber-06",
      "--amber-07",
      "--amber-08",
      "--amber-09",
      "--amber-10",
      "--amber-worker-warning",
    ]),
  },
  {
    name: "Palette / Orange",
    tokens: tokens(["--orange-06"]),
  },
  {
    name: "Semantic / Text And Action",
    tokens: tokens([
      "--color-text-primary",
      "--color-text-secondary",
      "--color-text-tertiary",
      "--color-text-disabled",
      "--color-text-inverse",
      "--color-action-primary",
      "--color-action-primary-hover",
      "--color-action-primary-active",
      "--accent",
      "--accent-foreground",
    ]),
  },
  {
    name: "Semantic / Status",
    tokens: tokens([
      "--color-success",
      "--color-success-bg",
      "--color-warning",
      "--color-warning-bg",
      "--color-danger",
      "--color-danger-bg",
      "--ok",
      "--danger",
      "--danger-bg",
      "--danger-banner-bg",
      "--danger-line",
      "--danger-line-strong",
      "--destructive",
    ]),
  },
  {
    name: "Semantic / Surface And Border",
    tokens: tokens([
      "--color-border-default",
      "--color-border-strong",
      "--color-border-interactive",
      "--color-surface-base",
      "--color-surface-raised",
      "--color-surface-overlay",
      "--color-surface-sunken",
      "--color-disabled-bg",
      "--color-disabled-fg",
      "--color-focus-ring",
      "--surface",
      "--surface-raised",
      "--line",
      "--line-strong",
      "--border",
      "--input",
      "--ring",
    ]),
  },
  {
    name: "App Surfaces",
    tokens: tokens([
      "--workspace-bg",
      "--titlebar-bg",
      "--conversation-bg",
      "--settings-bg",
      "--settings-panel-bg",
      "--sidebar-bg",
      "--sidebar-collapsed-bg",
      "--automation-details-bg",
      "--worker-panel-bg",
      "--worker-title-bg",
      "--user-message-bg",
      "--background",
      "--foreground",
      "--popover",
      "--popover-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
    ]),
  },
  {
    name: "Glass",
    tokens: [
      {
        name: "--composer-glass-bg",
        value: "var(--composer-glass-bg)",
        kind: "color",
      },
      {
        name: "--composer-glass-control-bg",
        value: "var(--composer-glass-control-bg)",
        kind: "color",
      },
      {
        name: "--composer-glass-border",
        value: "var(--composer-glass-border)",
        kind: "color",
      },
      {
        name: "--composer-glass-divider",
        value: "var(--composer-glass-divider)",
        kind: "color",
      },
      {
        name: "--composer-glass-highlight",
        value: "var(--composer-glass-highlight)",
        kind: "color",
      },
      {
        name: "--composer-glass-lowlight",
        value: "var(--composer-glass-lowlight)",
        kind: "color",
      },
      {
        name: "--composer-glass-glint",
        value: "var(--composer-glass-glint)",
        kind: "color",
      },
      {
        name: "--composer-glass-filter",
        value: "var(--composer-glass-filter)",
        kind: "effect",
      },
      {
        name: "--composer-glass-shadow",
        value: "var(--composer-glass-shadow)",
        kind: "effect",
      },
      {
        name: "--tinted-glass-tint",
        value: "var(--tinted-glass-tint)",
        kind: "color",
      },
      {
        name: "--tinted-glass-edge-size",
        value: "var(--tinted-glass-edge-size)",
        kind: "space",
      },
      {
        name: "--tinted-glass-filter",
        value: "var(--tinted-glass-filter)",
        kind: "effect",
      },
      {
        name: "--tinted-glass-shadow",
        value: "var(--tinted-glass-shadow)",
        kind: "effect",
      },
    ],
  },
  {
    name: "Controls And Overlays",
    tokens: tokens([
      "--control-bg",
      "--control-hover-bg",
      "--context-bar-bg",
      "--selection",
      "--selection-strong",
      "--icon-muted",
      "--placeholder",
      "--send-bg",
      "--send-stop-bg",
      "--send-fg",
      "--send-disabled-bg",
      "--switch-thumb",
      "--switch-track-bg",
      "--switch-inline-track-bg",
      "--dialog-overlay-bg",
      "--command-overlay-bg",
      "--chrome-button-bg",
      "--chrome-divider-bg",
      "--color-mix-light",
    ]),
  },
  {
    name: "Access And Context",
    tokens: tokens([
      "--worker-active",
      "--worker-warning",
      "--access-full",
      "--access-ask",
      "--access-read",
      "--context-track-bg",
      "--context-chart-1",
      "--context-chart-2",
      "--context-chart-3",
      "--context-chart-4",
      "--context-chart-5",
      "--context-chart-6",
      "--context-chart-free",
      "--text-primary",
      "--text-secondary",
      "--text-tertiary",
    ]),
  },
  {
    name: "Shape And Space",
    tokens: [
      { name: "--space-xs", value: "var(--space-xs)", kind: "space" },
      { name: "--space-md", value: "var(--space-md)", kind: "space" },
      {
        name: "--radius-control",
        value: "var(--radius-control)",
        kind: "radius",
      },
      {
        name: "--radius-popover",
        value: "var(--radius-popover)",
        kind: "radius",
      },
      { name: "--radius-pill", value: "var(--radius-pill)", kind: "radius" },
    ],
  },
  {
    name: "Typography",
    tokens: [
      { name: "--font-size-2", value: "var(--font-size-2)", kind: "type" },
      { name: "--font-size-3", value: "var(--font-size-3)", kind: "type" },
      {
        name: "--typo-panel-title-size",
        value: "var(--typo-panel-title-size)",
        kind: "type",
      },
      {
        name: "--font-weight-medium",
        value: "var(--font-weight-medium)",
        kind: "type",
      },
    ],
  },
];

const chartData = [
  { label: "Mon", value: 18 },
  { label: "Tue", value: 32 },
  { label: "Wed", value: 24 },
  { label: "Thu", value: 41 },
];

const typographyRows: Array<[string, ReactNode]> = [
  ["H1", <Typo.H1 as="span">Conversation headline</Typo.H1>],
  ["H2", <Typo.H2 as="span">Dashboard title</Typo.H2>],
  ["H3", <Typo.H3 as="span">Section heading</Typo.H3>],
  ["H4", <Typo.H4 as="span">Panel heading</Typo.H4>],
  ["H5", <Typo.H5 as="span">Compact heading</Typo.H5>],
  ["H6", <Typo.H6 as="span">Micro heading</Typo.H6>],
  [
    "Body",
    <Typo.Body as="span">Body text uses Butler typography tokens.</Typo.Body>,
  ],
  ["Caption", <Typo.Caption>Caption text</Typo.Caption>],
  ["Label", <Typo.Label as="span">Field label</Typo.Label>],
  ["Code", <Typo.Code>const token = true</Typo.Code>],
  ["AppTitle", <Typo.AppTitle>Butler</Typo.AppTitle>],
  ["PanelTitle", <Typo.PanelTitle>Panel title</Typo.PanelTitle>],
  ["SectionTitle", <Typo.SectionTitle>Section title</Typo.SectionTitle>],
  ["MetricValue", <Typo.MetricValue>42%</Typo.MetricValue>],
];

export const designSystemComponents: DesignSystemComponentMeta[] = [
  {
    name: "Button",
    path: "components/Button",
    tags: ["action", "control", "borderless"],
    fixture: () => (
      <ButtonContainer size="default">
        <Button iconStart={<Plus size={16} />} text="Create" />
        <Button
          iconStart={<Search size={16} />}
          text="Search"
          variant="outline"
        />
        <Button
          iconEnd={<Plus size={16} />}
          text="Borderless"
          variant="borderless"
        />
      </ButtonContainer>
    ),
  },
  {
    name: "ButtonContainer",
    path: "components/ButtonContainer",
    tags: ["action", "buttons", "spacing"],
    fixture: ButtonContainerFixture,
  },
  {
    name: "PillButton",
    path: "components/PillButton",
    tags: ["action", "composer", "pill"],
    fixture: () => <PillButton icon={<Search size={16} />}>Model</PillButton>,
  },
  {
    name: "Clickable",
    path: "components/Clickable",
    tags: ["role-button", "nested-action", "row"],
    fixture: () => (
      <Clickable aria-label="Open project" onClick={() => undefined}>
        <Stack align="row" cross="center" justify="between">
          <Typo.Body>Clickable row</Typo.Body>
          <IconButton label="Nested action">
            <Plus size={16} />
          </IconButton>
        </Stack>
      </Clickable>
    ),
  },
  {
    name: "Card",
    path: "components/Card",
    tags: ["surface", "container", "card"],
    fixture: CardFixture,
  },
  {
    name: "TintedGlass",
    path: "components/TintedGlass",
    tags: ["surface", "glass", "overlay"],
    fixture: TintedGlassFixture,
  },
  {
    name: "Skeleton",
    path: "components/Skeleton",
    tags: ["loading", "placeholder", "shimmer"],
    fixture: SkeletonFixture,
  },
  {
    name: "IconButton",
    path: "components/IconButton",
    tags: ["action", "icon-only"],
    fixture: () => (
      <IconButton label="Add item">
        <Plus aria-hidden size={16} />
      </IconButton>
    ),
  },
  {
    name: "Input",
    path: "components/Input",
    tags: ["form", "text-entry"],
    fixture: () => (
      <Stack gap="2">
        <Field>
          <Label htmlFor="ds-input">Input</Label>
          <Input
            id="ds-input"
            defaultValue="Butler task"
            placeholder="Butler task"
          />
        </Field>
        <Input aria-label="Placeholder input" placeholder="Placeholder only" />
      </Stack>
    ),
  },
  {
    name: "Textarea",
    path: "components/Textarea",
    tags: ["form", "long-text"],
    fixture: () => (
      <Textarea
        defaultValue="Actual context value"
        placeholder="Write context"
      />
    ),
  },
  {
    name: "Field",
    path: "components/Field",
    tags: ["form", "validation"],
    fixture: () => (
      <Field>
        <Label htmlFor="ds-field">Field label</Label>
        <Input id="ds-field" defaultValue="Visible value" placeholder="Value" />
      </Field>
    ),
  },
  {
    name: "Label",
    path: "components/Label",
    tags: ["form", "accessibility"],
    fixture: () => <Label htmlFor="ds-label-sample">Label text</Label>,
  },
  {
    name: "NativeSelect",
    path: "components/NativeSelect",
    tags: ["form", "mobile"],
    fixture: () => (
      <NativeSelect aria-label="Density">
        <option>Comfortable</option>
        <option>Compact</option>
      </NativeSelect>
    ),
  },
  {
    name: "Select",
    path: "components/Select",
    tags: ["form", "selection"],
    fixture: () => (
      <Select defaultValue="one">
        <SelectTrigger>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
          <SelectItem value="two">Two</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
  {
    name: "Slider",
    path: "components/Slider",
    tags: ["form", "range", "settings"],
    fixture: SliderFixture,
  },
  {
    name: "Switch",
    path: "components/Switch",
    tags: ["form", "toggle"],
    fixture: () => <Switch aria-label="Enable" />,
  },
  {
    name: "Dialog",
    path: "components/Dialog",
    tags: ["overlay", "focused-task"],
    fixture: () => (
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Open dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog description</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    name: "Popover",
    path: "components/Popover",
    tags: ["overlay", "contextual"],
    fixture: () => (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Open popover</Button>
        </PopoverTrigger>
        <PopoverContent>Popover content</PopoverContent>
      </Popover>
    ),
  },
  {
    name: "DropdownMenu",
    path: "components/DropdownMenu",
    tags: ["menu", "command"],
    fixture: () => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    name: "ContextMenu",
    path: "components/ContextMenu",
    tags: ["menu", "secondary-action"],
    fixture: () => (
      <ContextMenu>
        <ContextMenuTrigger>
          <Button variant="outline">Right click</Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ),
  },
  {
    name: "Tabs",
    path: "components/Tabs",
    tags: ["navigation", "view-switching"],
    fixture: TabsFixture,
  },
  {
    name: "Breadcrumb",
    path: "components/Breadcrumb",
    tags: ["navigation", "hierarchy"],
    fixture: () => (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>Project</BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Session</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    ),
  },
  {
    name: "Separator",
    path: "components/Separator",
    tags: ["layout", "structure"],
    fixture: () => (
      <Stack gap="2">
        <Typo.Body>Line</Typo.Body>
        <Separator line tone="default" />
        <Typo.Body>Spacing only</Typo.Body>
        <Separator line={false} space="md" />
        <Stack align="row" cross="center" gap="2">
          <Typo.Body>Vertical</Typo.Body>
          <Separator orientation="vertical" tone="accent" />
          <Typo.Body>Accent</Typo.Body>
        </Stack>
      </Stack>
    ),
  },
  {
    name: "Stack",
    path: "components/Stack",
    tags: ["layout", "responsive"],
    fixture: () => (
      <Stack gap="2">
        <Typo.Body>One-dimensional layout</Typo.Body>
        <Typo.Caption>Use ButtonContainer for adjacent buttons.</Typo.Caption>
      </Stack>
    ),
  },
  {
    name: "Grid",
    path: "components/Grid",
    tags: ["layout", "responsive"],
    fixture: () => (
      <Grid gap="2">
        <Typo.Body>A</Typo.Body>
        <Typo.Body>B</Typo.Body>
      </Grid>
    ),
  },
  {
    name: "Section",
    path: "components/Section",
    tags: ["layout", "region"],
    fixture: () => (
      <Section title="Section" description="Responsive section copy">
        <Button size="sm">Action</Button>
      </Section>
    ),
  },
  {
    name: "Space",
    path: "components/Space",
    tags: ["layout", "spacing"],
    fixture: () => (
      <>
        <Button size="sm">Top</Button>
        <Space size="md" />
        <Button size="sm" variant="outline">
          Bottom
        </Button>
      </>
    ),
  },
  {
    name: "Typo",
    path: "components/Typo",
    tags: ["typography", "hierarchy"],
    fixture: () => (
      <Stack gap="2">
        {typographyRows.map(([name, sample]) => (
          <Stack
            align="row"
            cross="center"
            gap="3"
            justify="between"
            key={name}
          >
            <Typo.Caption>{name}</Typo.Caption>
            {sample}
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    name: "Icons",
    path: "components/Icons",
    tags: ["iconography", "action"],
    fixture: () => (
      <Stack align="row" gap="2">
        <Folder size={18} />
        <Search size={18} />
        <Plus size={18} />
      </Stack>
    ),
  },
  {
    name: "Tooltip",
    path: "components/Tooltip",
    tags: ["help", "accessibility"],
    fixture: () => (
      <Tooltip label="Tooltip copy">
        <Button variant="outline">Hover</Button>
      </Tooltip>
    ),
  },
  {
    name: "Chart",
    path: "components/Chart",
    tags: ["data", "analytics"],
    fixture: () => (
      <ChartContainer
        config={{ value: { label: "Value", color: "var(--accent)" } }}
        initialDimension={{ width: 240, height: 150 }}
      >
        <BarChart data={chartData}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <Bar dataKey="value" fill="var(--accent)" radius={4} />
        </BarChart>
      </ChartContainer>
    ),
  },
];

export const designSystemBlocks: DesignSystemBlockMeta[] = [
  {
    name: "AdaptiveShell",
    path: "blocks/AdaptiveShell",
    tags: ["shell", "drawer", "responsive", "adaptive"],
    fixture: AdaptiveShellFixture,
  },
  {
    name: "NavRow",
    path: "blocks/NavRow",
    tags: ["navigation", "sidebar", "row"],
    fixture: NavRowFixture,
  },
  {
    name: "NavSection",
    path: "blocks/NavSection",
    tags: ["navigation", "section", "sidebar"],
    fixture: NavSectionFixture,
  },
  {
    name: "CollapsibleNavGroup",
    path: "blocks/CollapsibleNavGroup",
    tags: ["navigation", "collapsible", "hierarchy"],
    fixture: CollapsibleNavGroupFixture,
  },
  {
    name: "RowActionCluster",
    path: "blocks/RowActionCluster",
    tags: ["actions", "buttons", "row"],
    fixture: RowActionClusterFixture,
  },
  {
    name: "OverflowActionMenu",
    path: "blocks/OverflowActionMenu",
    tags: ["menu", "overflow", "actions"],
    fixture: OverflowActionMenuFixture,
  },
  {
    name: "FormRow",
    path: "blocks/FormRow",
    tags: ["form", "field", "input"],
    fixture: FormRowFixture,
  },
  {
    name: "FormSection",
    path: "blocks/FormSection",
    tags: ["form", "section", "grouping"],
    fixture: FormSectionFixture,
  },
  {
    name: "PanelHeader",
    path: "blocks/PanelHeader",
    tags: ["panel", "header", "title"],
    fixture: PanelHeaderFixture,
  },
  {
    name: "PromptSuggestionList",
    path: "blocks/PromptSuggestionList",
    tags: ["empty", "prompt", "suggestion"],
    fixture: PromptSuggestionListFixture,
  },
  {
    name: "SurfacePanel",
    path: "blocks/SurfacePanel",
    tags: ["panel", "card", "surface"],
    fixture: SurfacePanelFixture,
  },
  {
    name: "MetricCard",
    path: "blocks/MetricCard",
    tags: ["metric", "dashboard", "analytics"],
    fixture: MetricCardFixture,
  },
  {
    name: "MetricGrid",
    path: "blocks/MetricGrid",
    tags: ["metric", "grid", "layout"],
    fixture: MetricGridFixture,
  },
  {
    name: "CardList",
    path: "blocks/CardList",
    tags: ["card", "list", "settings"],
    fixture: CardListFixture,
  },
  {
    name: "SortableCardList",
    path: "blocks/SortableCardList",
    tags: ["card", "list", "sortable", "drag", "keyboard"],
    fixture: SortableCardListFixture,
  },
  {
    name: "ListRow",
    path: "blocks/ListRow",
    tags: ["list", "row", "item"],
    fixture: ListRowFixture,
  },
  {
    name: "ResourceSummary",
    path: "blocks/ResourceSummary",
    tags: ["resource", "summary", "content"],
    fixture: ResourceSummaryFixture,
  },
  {
    name: "ResourceTile",
    path: "blocks/ResourceTile",
    tags: ["tile", "card", "resource"],
    fixture: ResourceTileFixture,
  },
  {
    name: "EmptyLine",
    path: "blocks/EmptyLine",
    tags: ["empty", "state", "placeholder"],
    fixture: EmptyLineFixture,
  },
  {
    name: "Notice",
    path: "blocks/Notice",
    tags: ["notice", "alert", "banner"],
    fixture: NoticeFixture,
  },
  {
    name: "ConversationShell",
    path: "blocks/ConversationShell",
    tags: ["conversation", "chat", "scroll"],
    fixture: ConversationShellFixture,
  },
  {
    name: "ComposerControl",
    path: "blocks/ComposerControl",
    tags: ["composer", "toolbar", "pill"],
    fixture: ComposerControlFixture,
  },
  {
    name: "OptionMenu",
    path: "blocks/OptionMenu",
    tags: ["menu", "popover", "options"],
    fixture: OptionMenuFixture,
  },
  {
    name: "FilteredSelectPopover",
    path: "blocks/FilteredSelectPopover",
    tags: ["menu", "popover", "filter", "search", "select"],
    fixture: FilteredSelectPopoverFixture,
  },
  {
    name: "ContextDonutButton",
    path: "blocks/ContextDonutButton",
    tags: ["composer", "context", "usage"],
    fixture: ContextDonutButtonFixture,
  },
  {
    name: "ComposerCard",
    path: "blocks/ComposerCard",
    tags: ["composer", "chat", "glass"],
    fixture: ComposerCardFixture,
  },
  {
    name: "ComposerAdjunctPanel",
    path: "blocks/ComposerAdjunctPanel",
    tags: ["composer", "panel", "adjunct"],
    fixture: ComposerAdjunctPanelFixture,
  },
  {
    name: "ComposerQueuePanel",
    path: "blocks/ComposerQueuePanel",
    tags: ["composer", "queue", "follow-up"],
    fixture: ComposerQueuePanelFixture,
  },
  {
    name: "AttachmentList",
    path: "blocks/AttachmentList",
    tags: ["attachment", "file", "message"],
    fixture: AttachmentListFixture,
  },
  {
    name: "MessageRow",
    path: "blocks/MessageRow",
    tags: ["message", "chat", "timeline"],
    fixture: MessageRowFixture,
  },
  {
    name: "MessageAvatarBlock",
    path: "blocks/MessageAvatarBlock",
    tags: ["avatar", "message", "role"],
    fixture: MessageAvatarBlockFixture,
  },
  {
    name: "ActivityFeed",
    path: "blocks/ActivityFeed",
    tags: ["activity", "feed", "status"],
    fixture: ActivityFeedFixture,
  },
  {
    name: "WorkActivityBlock",
    path: "blocks/WorkActivityBlock",
    tags: ["conversation", "work", "progress"],
    fixture: WorkActivityBlockFixture,
  },
  {
    name: "DisclosureRow",
    path: "blocks/DisclosureRow",
    tags: ["disclosure", "row", "details"],
    fixture: DisclosureRowFixture,
  },
  {
    name: "InspectorPanel",
    path: "blocks/InspectorPanel",
    tags: ["inspector", "panel", "section"],
    fixture: InspectorPanelFixture,
  },
  {
    name: "InspectorShell",
    path: "blocks/InspectorShell",
    tags: ["inspector", "shell", "tabs"],
    fixture: InspectorShellFixture,
  },
  {
    name: "KeyValueRow",
    path: "blocks/KeyValueRow",
    tags: ["key-value", "metadata", "inspector"],
    fixture: KeyValueRowFixture,
  },
  {
    name: "ProgressMeter",
    path: "blocks/ProgressMeter",
    tags: ["progress", "meter", "status"],
    fixture: ProgressMeterFixture,
  },
  {
    name: "ProgressStepper",
    path: "blocks/ProgressStepper",
    tags: ["progress", "stepper", "wizard"],
    fixture: ProgressStepperFixture,
  },
  {
    name: "SetupWizardShell",
    path: "blocks/SetupWizardShell",
    tags: ["setup", "wizard", "glass"],
    fixture: SetupWizardShellFixture,
  },
  {
    name: "TodoProgressPanel",
    path: "blocks/TodoProgressPanel",
    tags: ["todo", "progress", "panel"],
    fixture: TodoProgressPanelFixture,
  },
  {
    name: "WorkerActivityPanel",
    path: "blocks/WorkerActivityPanel",
    tags: ["worker", "activity", "panel"],
    fixture: WorkerActivityPanelFixture,
  },
  {
    name: "WorkerActivityRow",
    path: "blocks/WorkerActivityRow",
    tags: ["worker", "activity", "actions"],
    fixture: WorkerActivityRowFixture,
  },
  {
    name: "SettingsField",
    path: "blocks/SettingsField",
    tags: ["settings", "field", "form"],
    fixture: SettingsFieldFixture,
  },
  {
    name: "SettingsHeader",
    path: "blocks/SettingsHeader",
    tags: ["settings", "header", "title"],
    fixture: SettingsHeaderFixture,
  },
  {
    name: "SettingsNav",
    path: "blocks/SettingsNav",
    tags: ["settings", "navigation", "sidebar"],
    fixture: SettingsNavFixture,
  },
  {
    name: "SettingsShell",
    path: "blocks/SettingsShell",
    tags: ["settings", "shell", "responsive"],
    fixture: SettingsShellFixture,
  },
  {
    name: "SettingsSecretRows",
    path: "blocks/SettingsSecretRows",
    tags: ["settings", "secrets", "rows"],
    fixture: SettingsSecretRowsFixture,
  },
  {
    name: "TokenInputControl",
    path: "blocks/TokenInputControl",
    tags: ["settings", "tokens", "input"],
    fixture: TokenInputControlFixture,
  },
  {
    name: "PercentInputControl",
    path: "blocks/PercentInputControl",
    tags: ["settings", "percent", "progress"],
    fixture: PercentInputControlFixture,
  },
  {
    name: "ManagementPage",
    path: "blocks/ManagementPage",
    tags: ["management", "page", "layout"],
    fixture: ManagementPageFixture,
  },
  {
    name: "DashboardHeader",
    path: "blocks/DashboardHeader",
    tags: ["dashboard", "header", "management"],
    fixture: DashboardHeaderFixture,
  },
  {
    name: "DocumentTile",
    path: "blocks/DocumentTile",
    tags: ["document", "tile", "resource"],
    fixture: DocumentTileFixture,
  },
  {
    name: "SessionRow",
    path: "blocks/SessionRow",
    tags: ["session", "chat", "row"],
    fixture: SessionRowFixture,
  },
  {
    name: "AutomationRow",
    path: "blocks/AutomationRow",
    tags: ["automation", "row", "status"],
    fixture: AutomationRowFixture,
  },
  {
    name: "AutomationRunList",
    path: "blocks/AutomationRunList",
    tags: ["automation", "runs", "history"],
    fixture: AutomationRunListFixture,
  },
  {
    name: "ActivityHeatmap",
    path: "blocks/ActivityHeatmap",
    tags: ["dashboard", "activity", "heatmap"],
    fixture: ActivityHeatmapFixture,
  },
  {
    name: "ArtifactList",
    path: "blocks/ArtifactList",
    tags: ["artifact", "list", "row"],
    fixture: ArtifactListFixture,
  },
  {
    name: "ArtifactPreview",
    path: "blocks/ArtifactPreview",
    tags: ["artifact", "preview", "document"],
    fixture: ArtifactPreviewFixture,
  },
  {
    name: "MarkdownContent",
    path: "blocks/MarkdownContent",
    tags: ["markdown", "document", "typography"],
    fixture: MarkdownContentFixture,
  },
  {
    name: "ScrollArea",
    path: "blocks/ScrollArea",
    tags: ["scroll", "panel", "chrome"],
    fixture: ScrollAreaFixture,
  },
  {
    name: "CommandPanel",
    path: "blocks/CommandPanel",
    tags: ["command", "search", "palette"],
    fixture: CommandPanelFixture,
  },
  {
    name: "DialogForm",
    path: "blocks/DialogForm",
    tags: ["dialog", "form", "modal"],
    fixture: DialogFormFixture,
  },
  {
    name: "ChromeFrame",
    path: "blocks/ChromeFrame",
    tags: ["chrome", "shell", "layout"],
    fixture: ChromeFrameFixture,
  },
  {
    name: "TitlebarShell",
    path: "blocks/TitlebarShell",
    tags: ["titlebar", "shell", "chrome"],
    fixture: TitlebarShellFixture,
  },
  {
    name: "SidebarShell",
    path: "blocks/SidebarShell",
    tags: ["sidebar", "shell", "navigation"],
    fixture: SidebarShellFixture,
  },
];

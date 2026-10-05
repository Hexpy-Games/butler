import { memo, useMemo, useRef, useState, type MouseEvent } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ReasoningEffort } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  appShellTheme,
  modelDisplayName,
  reasoningBudgetSummary,
  reasoningOptionLabel,
  tokenWindowLabel,
} from "@/app/utils.ts";
import {
  ComposerControl,
  ComposerSelectControl,
  ContextDonutButton,
  FilteredSelectPopover,
  GitBranch,
  ImageIcon,
  ListChecks,
  MessageSquarePlus,
  Monitor,
  OptionMenu,
  OptionMenuItem,
  OptionMenuSection,
  Paperclip,
  PillButton,
  Plus,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  Stack,
  X,
} from "@/butler-ds";
import { AccessModeOptions } from "@/components/conversation/AccessModeOptions";
import { accessLabel, accessModeIcon, accessPermissionTone } from "@/components/conversation/accessModeUtils";
import { ComposerProjectDocumentMenu } from "@/components/conversation/ComposerProjectDocumentMenu";
import { activeProjectId } from "@/components/conversation/composerProjectContext";
import { composerImagePolicy, imageRefusalLabel } from "@/components/conversation/composerImagePolicy";
import { useComposerStore } from "@/components/conversation/composerStore";
import { ContextUsagePopover } from "@/components/conversation/ContextUsagePopover";
import { contextModel, usageAuthMode } from "@/components/conversation/usageAuthMode";
import buttonStyles from "@/butler-ds/components/Button/Button.module.css";
import pillStyles from "@/butler-ds/components/PillButton/PillButton.module.css";

// Proposal copies of the six bottom-row controls in components/conversation. Each body is the product
// component unchanged (same stores, handlers, menus and copy keys); only the trigger becomes the
// standard glass PillButton surface.
//
// DS gap: ComposerControl / ComposerSelectControl take no `surface` prop. Both already forward their
// remaining props to PillButton (directly, or through Radix Slot), so the proposal passes
// `surface="glass"` through that spread. The implementation adds the typed prop instead.
//
// DS gap: the glass surface has a 32px floor (PillButton.module.css `.glass` min-height) but Button
// has no 32px icon size, so an icon-only glass pill can't be a circle at 32 (it renders 30x32).
// The row therefore uses Button's `lg` height (34px) for text pills and `icon-lg` (34x34) for the
// icon-only pills: one height, true circles. Touch widths: every pill is 44px, circles 44x44.
const GLASS = { surface: "glass", size: "lg" } as object;

// DS gap: ComposerControl's touch rule (`.control[data-slot="button"][data-compact]`, which keeps the
// pill at 30px) only matches when nothing overwrites Button's data-slot. Inside a PopoverTrigger it
// becomes "popover-trigger" (44px pill); inside a Select trigger it stays "button" (30px pill). The
// select pill gets the same data-slot override so every pill in the row has one height (44px touch).
const GLASS_SELECT = { surface: "glass", size: "lg", "data-slot": "select-trigger" } as object;

// Icon-only glass pill: Button's `icon-lg` through PillButton's spread (see the gap note above).
const ICON_ONLY = { size: "icon-lg" } as object;

/** ComposerAttachmentMenu: IconButton trigger -> glass PillButton (icon only). */
export function AttachmentPill() {
  useAppLocale();
  const activeChatId = useComposerStore((state) => state.draftSessionId);
  const navigation = useButlerStore((state) => state.navigation);
  const settings = useButlerStore((state) => state.settings);
  const projectId = activeProjectId(navigation, activeChatId);
  const uploadingCount = useComposerStore((store) => store.uploadingCount);
  const planMode = useComposerStore((store) => store.planMode);
  const handlePlanModeChange = useComposerStore((store) => store.handlePlanModeChange);
  const openAttachmentPicker = useComposerStore((store) => store.openAttachmentPicker);
  const imagesBlockedBy = useComposerStore((store) => composerImagePolicy(store.activeModel).blockedBy);
  const [open, setOpen] = useState(false);
  const theme = appShellTheme(settings);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PillButton
          surface="glass"
          data-test-class="attachment-button"
          disabled={uploadingCount > 0}
          aria-label={appCopy.composer.featureDrawer}
          title={appCopy.composer.featureDrawer}
          icon={<Plus size="md" />}
          {...ICON_ONLY}
        >
          {null}
        </PillButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        theme={theme}
        data-menu-size="content"
        onOpenAutoFocus={(event) => {
          const menu = event.currentTarget as HTMLElement;
          menu.querySelector<HTMLButtonElement>('[data-slot="option-menu-item"]:not(:disabled):not([aria-disabled="true"])')?.focus();
        }}
        side="top"
        sideOffset={10}
      >
        <OptionMenu title={appCopy.composer.featureDrawer} size="fit">
          <OptionMenuSection title={appCopy.composer.attachments}>
            {projectId ? <ComposerProjectDocumentMenu theme={theme} onClose={() => setOpen(false)} projectId={projectId} /> : null}
            <OptionMenuItem icon={<Paperclip size="md" />} label={appCopy.composer.attachFile}
              onClick={() => { openAttachmentPicker(); setOpen(false); }} />
            <OptionMenuItem icon={<ImageIcon size="md" />} label={appCopy.composer.attachImage}
              disabledReason={imagesBlockedBy ? imageRefusalLabel(imagesBlockedBy) : undefined}
              onClick={() => { openAttachmentPicker("images"); setOpen(false); }} />
          </OptionMenuSection>
          <OptionMenuSection title={appCopy.composer.responseMode}>
            <OptionMenuItem icon={<MessageSquarePlus size="md" />} label={appCopy.composer.normal} selected={!planMode}
              onClick={() => { handlePlanModeChange(false); setOpen(false); }} />
            {projectId ? (
              <OptionMenuItem icon={<ListChecks size="md" />} label={appCopy.composer.plan} selected={planMode}
                onClick={() => { handlePlanModeChange(true); setOpen(false); }} />
            ) : null}
          </OptionMenuSection>
        </OptionMenu>
      </PopoverContent>
    </Popover>
  );
}

/** AccessModeMenu: ComposerControl trigger on the glass surface. */
export function AccessPill() {
  useAppLocale();
  const accessMode = useComposerStore((store) => store.accessMode);
  const accessMenuOpen = useComposerStore((store) => store.accessMenuOpen);
  const setAccessMenuOpen = useComposerStore((store) => store.setAccessMenuOpen);
  const handleAccessModeChange = useComposerStore((store) => store.handleAccessModeChange);
  const settings = useButlerStore((store) => store.settings);
  return (
    <Popover open={accessMenuOpen} onOpenChange={setAccessMenuOpen}>
      <PopoverTrigger asChild>
        <ComposerControl
          {...GLASS}
          aria-label={`${appCopy.composer.permission}: ${accessLabel(accessMode)}`}
          compact="icon"
          data-test-class="access-button"
          icon={accessModeIcon(accessMode)}
          permissionTone={accessPermissionTone(accessMode)}
          label={<span data-test-class="composer-control-label">{accessLabel(accessMode)}</span>}
        />
      </PopoverTrigger>
      <PopoverContent align="start" theme={appShellTheme(settings)} data-menu-size="compact" side="top" sideOffset={10}>
        <AccessModeOptions value={accessMode} onSelect={(item) => { handleAccessModeChange(item); setAccessMenuOpen(false); }} />
      </PopoverContent>
    </Popover>
  );
}

/** ComposerWorkspaceSelect: ComposerSelectControl on the glass surface. */
export function WorkspacePill() {
  useAppLocale();
  const mode = useComposerStore((state) => state.workspaceMode);
  const setMode = useComposerStore((state) => state.setWorkspaceMode);
  const isSending = useComposerStore((state) => state.isSending);
  const copy = appCopy.composer;
  return (
    <Select value={mode} disabled={isSending} onValueChange={(value) => setMode(value === "worktree" ? "worktree" : "local")}>
      <ComposerSelectControl {...GLASS_SELECT} aria-label={copy.workspace} data-test-class="composer-workspace-select"
        icon={mode === "worktree" ? <GitBranch size="sm" /> : <Monitor size="sm" />}>
        <SelectValue>{mode === "worktree" ? copy.workspaceWorktree : copy.workspaceLocal}</SelectValue>
      </ComposerSelectControl>
      <SelectContent position="popper" side="top">
        <SelectItem value="local">{copy.workspaceLocal}</SelectItem>
        <SelectItem value="worktree">{copy.workspaceWorktree}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** ComposerPlanModeBadge: Tag with remove -> glass PillButton whose click turns Plan off. */
export function PlanPill() {
  useAppLocale();
  const planMode = useComposerStore((store) => store.planMode);
  const setPlanMode = useComposerStore((store) => store.handlePlanModeChange);
  if (!planMode) return null;
  return (
    <PillButton surface="glass" {...GLASS} data-test-class="composer-plan-mode-badge"
      icon={<ListChecks aria-hidden="true" size="xs" />}
      onClick={() => setPlanMode(false)}
      aria-label={`${appCopy.composer.plan} ${appCopy.common.cancel}`}>
      <Stack as="span" align="row" cross="center" gap="xs">
        {appCopy.composer.plan}<X aria-hidden="true" size="xs" />
      </Stack>
    </PillButton>
  );
}

// Screen-level stand-in for the approved `ContextDonutButton surface="glass"` (not on main yet). It
// renders the real ContextDonutButton and gives it the real Button pill + PillButton glass classes,
// which is what the DS change does internally (PillButton surface="glass" around the same ring).
// No proposal CSS: both class sets come from the DS modules. The implementation replaces this with
// `<ContextDonutButton surface="glass" />`.
const CONTEXT_GLASS = {
  className: [buttonStyles.button, buttonStyles.variantBorderless, buttonStyles.sizeIconLg, buttonStyles.shapePill, pillStyles.glass].join(" "),
  "data-slot": "button",
  "data-size": "icon-lg",
  "data-shape": "pill",
  "data-surface": "glass-pill",
} as object;

/** ComposerContextControl: ContextDonutButton on the glass pill surface (see CONTEXT_GLASS). */
export const ContextPill = memo(function ContextPill() {
  useAppLocale();
  const context = useComposerStore((store) => store.context);
  const models = useComposerStore((store) => store.models);
  const activeModel = useComposerStore((store) => store.activeModel);
  const open = useComposerStore((store) => store.contextPopoverOpen);
  const setOpen = useComposerStore((store) => store.setContextPopoverOpen);
  const settings = useButlerStore((store) => store.settings);
  const activeChatId = useButlerStore((store) => store.activeChatId);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!context) return null;
  const close = () => { setPinned(false); setOpen(false); };
  const togglePin = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    triggerRef.current = event.currentTarget;
    if (pinned) { close(); return; }
    setPinned(true);
    setOpen(true);
  };
  const mode = usageAuthMode(contextModel(models, context, activeModel), context);
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <ContextDonutButton {...CONTEXT_GLASS} data-test-class="context-donut-button" ratio={context.ratio ?? 0}
          onClick={togglePin} onPointerEnter={() => setOpen(true)} onPointerLeave={() => { if (!pinned) setOpen(false); }}
          aria-label={appCopy.composer.contextDetails} />
      </PopoverTrigger>
      <PopoverContent data-test-class="context-popover" data-pinned={pinned ? "true" : undefined} align="center"
        theme={appShellTheme(settings)} side="top" sideOffset={10} width="narrow"
        onCloseAutoFocus={(event) => { event.preventDefault(); if (pinned) triggerRef.current?.focus(); }}>
        <ContextUsagePopover context={context} mode={mode} sessionId={context.session_id ?? activeChatId} onDetails={close} />
      </PopoverContent>
    </Popover>
  );
});

/** ModelMenu: ComposerControl trigger on the glass surface. */
export const ModelPill = memo(function ModelPill() {
  useAppLocale();
  const modelMenuOpen = useComposerStore((store) => store.modelMenuOpen);
  const setModelMenuOpen = useComposerStore((store) => store.setModelMenuOpen);
  const activeModel = useComposerStore((store) => store.activeModel);
  const reasoning = useComposerStore((store) => store.reasoning);
  const model = useComposerStore((store) => store.model);
  const models = useComposerStore((store) => store.models);
  const availableReasoning = useComposerStore((store) => store.availableReasoning);
  const handleModelChoice = useComposerStore((store) => store.handleModelChoice);
  const handleReasoningChange = useComposerStore((store) => store.handleReasoningChange);
  const settings = useButlerStore((store) => store.settings);
  const [searchValue, setSearchValue] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const providers = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((item) => !seen.has(item.provider_id) && Boolean(seen.add(item.provider_id)))
      .map((item) => ({ id: item.provider_id, label: item.provider_label }));
  }, [models]);
  const modelGroups = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return providers.map((provider) => ({
      id: provider.id,
      title: provider.label,
      items: models
        .filter((item) => (providerFilter === "all" || item.provider_id === providerFilter) && item.provider_id === provider.id)
        .filter((item) => !query || [modelDisplayName(item), item.model_id, item.provider_label].some((value) => value.toLowerCase().includes(query)))
        .map((item) => ({
          id: item.model_ref,
          label: modelDisplayName(item),
          description: tokenWindowLabel(item.context_window_tokens),
          selected: item.model_ref === model,
          onSelect: () => handleModelChoice(item),
        })),
    }));
  }, [handleModelChoice, model, models, providerFilter, providers, searchValue]);
  if (!activeModel) return null;
  return (
    <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
      <PopoverTrigger asChild>
        <ComposerControl
          {...GLASS}
          data-test-class="model-button"
          label={<span data-test-class="composer-model-name">{modelDisplayName(activeModel)}</span>}
          detail={<span data-test-class="composer-model-summary">{reasoningBudgetSummary(activeModel, reasoning)}</span>}
        />
      </PopoverTrigger>
      <PopoverContent align="end" theme={appShellTheme(settings)} data-menu-size="fit" side="top" sideOffset={10}>
        <FilteredSelectPopover
          title={appCopy.composer.model}
          searchLabel={appCopy.composer.model}
          searchPlaceholder={appCopy.composer.modelSearch}
          searchClearLabel={appCopy.composer.modelSearchClear}
          searchValue={searchValue}
          filters={[{ id: "all", label: appCopy.composer.allProviders }, ...providers]}
          activeFilterId={providerFilter}
          onFilterChange={setProviderFilter}
          onSearchChange={setSearchValue}
          emptyLabel={appCopy.composer.noModels}
          groups={modelGroups}
          footerTitle={appCopy.composer.reasoning}
          footerOptions={(availableReasoning as ReasoningEffort[]).map((item) => ({
            id: item,
            label: reasoningOptionLabel(activeModel, item),
            selected: item === reasoning,
            onSelect: () => { handleReasoningChange(item); setModelMenuOpen(false); },
          }))}
        />
      </PopoverContent>
    </Popover>
  );
});

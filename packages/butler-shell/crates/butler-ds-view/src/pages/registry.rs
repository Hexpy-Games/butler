//! The page list of the viewer, in the React viewer's order.
use super::{
    Page, activity_feed, activity_heatmap, activity_strip, adaptive_shell, animated_number,
    artifact_list, artifact_preview, aspect_frame, attachment_list, automation_run_list, avatar,
    block_action_frame, block_columns, block_tabs, bottom_sheet, boxes, breadcrumb,
    butler_thinking_mark, button, card, card_list, changed_line_diff, chart, check_card,
    choice_card, clickable, collapsible, collapsible_nav_group, command_panel,
    composer_adjunct_panel, composer_card, composer_control, composer_decision_panel,
    composer_question_panel, context_donut_button, context_menu, conversation_shell, copy_button,
    dashboard_header, dialog, dialog_form, disclosure_row, document_editor, done_icon_button,
    drag_preview, dropdown_menu, element_chip, empty_line, event_timeline, expandable_text, field,
    filtered_select_popover, form_section, glyph_toggle, grid, group_tile, history_row,
    icon_button, icon_slot, icon_tile, image_viewer, inline, inline_reference, input,
    inspector_panel, item_card, kanban_board, kbd, key_value_row, label, layout, library_card,
    list_row, management_page, markdown_content, mask_canvas, media_frame, message_avatar_block,
    message_row, meta_list, metric_card, metric_grid, native_select, nav_drop_target, nav_row,
    nav_section, notice, option_menu, overflow_action_menu, page_container, panel_header,
    percent_input_control, pill_button, popover, presence, progress_meter, progress_ring,
    prompt_suggestion_list, provider_logo, question_answer_card, queued_message,
    rolling_status_line, rolling_swap, scroll_area, section, segmented_control, select, separator,
    settings_action_field, settings_field, settings_header, settings_nav, settings_secret_rows,
    settings_section, settings_shell, setup_wizard_shell, setup_wizard_step_card, sidebar_shell,
    skeleton, slider, sortable_card_list, span_bar, spinner, split_button, stack, status_capsule,
    status_checklist, step_sortable_list, success_check, suggestion_list, surface_panel, switch,
    tab_strip, tabs, tag, tag_color_swatches, tag_field, task_graph_canvas, task_graph_card,
    task_graph_detail, task_graph_lanes, task_graph_section, textarea, time_picker, tinted_glass,
    titlebar_shell, toast, todo_progress_panel, token_input_control, tooltip, typo, unread_dot,
    usage_bars, usage_summary_rows, version_history, wallpaper, wallpaper_stage, work_activity,
    worker_activity_panel, worker_activity_row,
};

use super::{address_field, page_band};

macro_rules! page {
    ($id:literal, $title:literal, $module:ident) => {
        Page {
            id: $id,
            title: $title,
            stories: $module::stories,
        }
    };
}

/// The primitives (B1 to B5, P2-S1).
fn primitives() -> Vec<Page> {
    vec![
        page!("presence", "Presence", presence),
        page!("box", "Box", boxes),
        page!("stack", "Stack", stack),
        page!("inline", "Inline", inline),
        page!("grid", "Grid", grid),
        page!("layout", "Layout", layout),
        page!("typo", "Typo", typo),
        page!("separator", "Separator", separator),
        page!("kbd", "Kbd", kbd),
        page!("label", "Label", label),
        page!("input", "Input", input),
        page!("textarea", "Textarea", textarea),
        page!("field", "Field", field),
        page!("native-select", "NativeSelect", native_select),
        page!("tinted-glass", "TintedGlass", tinted_glass),
        page!("card", "Card", card),
        page!("tooltip", "Tooltip", tooltip),
        page!("popover", "Popover", popover),
        page!("dropdown-menu", "DropdownMenu", dropdown_menu),
        page!("context-menu", "ContextMenu", context_menu),
        page!("select", "Select", select),
        page!("dialog", "Dialog", dialog),
        page!("bottom-sheet", "BottomSheet", bottom_sheet),
        page!("toast", "Toast", toast),
        page!("button", "Button", button),
        page!("icon-button", "IconButton", icon_button),
        page!("pill-button", "PillButton", pill_button),
        page!("clickable", "Clickable", clickable),
        page!("copy-button", "CopyButton", copy_button),
        page!("done-icon-button", "DoneIconButton", done_icon_button),
        page!("glyph-toggle", "GlyphToggle", glyph_toggle),
        page!("segmented-control", "SegmentedControl", segmented_control),
        page!("switch", "Switch", switch),
        page!("slider", "Slider", slider),
        page!("spinner", "Spinner", spinner),
        page!("skeleton", "Skeleton", skeleton),
        page!("progress-ring", "ProgressRing", progress_ring),
        page!("success-check", "SuccessCheck", success_check),
        page!("scroll-area", "ScrollArea", scroll_area),
        page!("collapsible", "Collapsible", collapsible),
        page!("tabs", "Tabs", tabs),
        page!("tag", "Tag", tag),
        page!("icon-slot", "IconSlot", icon_slot),
        page!("unread-dot", "UnreadDot", unread_dot),
        page!("aspect-frame", "AspectFrame", aspect_frame),
        page!("meta-list", "MetaList", meta_list),
        page!("rolling-swap", "RollingSwap", rolling_swap),
        page!(
            "rolling-status-line",
            "RollingStatusLine",
            rolling_status_line
        ),
        page!("animated-number", "AnimatedNumber", animated_number),
        page!("avatar", "Avatar", avatar),
        page!("icon-tile", "IconTile", icon_tile),
        page!(
            "butler-thinking-mark",
            "ButlerThinkingMark",
            butler_thinking_mark
        ),
        page!("expandable-text", "ExpandableText", expandable_text),
        page!("media-frame", "MediaFrame", media_frame),
        page!("inline-reference", "InlineReference", inline_reference),
        page!("time-picker", "TimePicker", time_picker),
        page!("provider-logo", "ProviderLogo", provider_logo),
    ]
}

/// The blocks (P2-S2 shells, P2-S3 navigation and rows).
fn blocks() -> Vec<Page> {
    vec![
        page!("adaptive-shell", "AdaptiveShell", adaptive_shell),
        page!(
            "conversation-shell",
            "ConversationShell",
            conversation_shell
        ),
        page!("sidebar-shell", "SidebarShell", sidebar_shell),
        page!("titlebar-shell", "TitlebarShell", titlebar_shell),
        page!("panel-header", "PanelHeader", panel_header),
        page!("surface-panel", "SurfacePanel", surface_panel),
        page!("wallpaper-stage", "WallpaperStage", wallpaper_stage),
        page!("inspector-panel", "InspectorPanel", inspector_panel),
        page!("nav-row", "NavRow", nav_row),
        page!("nav-section", "NavSection", nav_section),
        page!(
            "collapsible-nav-group",
            "CollapsibleNavGroup",
            collapsible_nav_group
        ),
        page!(
            "overflow-action-menu",
            "OverflowActionMenu",
            overflow_action_menu
        ),
        page!("nav-drop-target", "NavDropTarget", nav_drop_target),
        page!("drag-preview", "DragPreview", drag_preview),
        page!("list-row", "ListRow", list_row),
        page!("disclosure-row", "DisclosureRow", disclosure_row),
        page!("key-value-row", "KeyValueRow", key_value_row),
        page!("empty-line", "EmptyLine", empty_line),
        page!("status-capsule", "StatusCapsule", status_capsule),
        page!("markdown-content", "MarkdownContent", markdown_content),
        page!("message-row", "MessageRow", message_row),
        page!(
            "message-avatar-block",
            "MessageAvatarBlock",
            message_avatar_block
        ),
        page!("work-activity-block", "WorkActivityBlock", work_activity),
        page!(
            "worker-activity-row",
            "WorkerActivityRow",
            worker_activity_row
        ),
        page!(
            "worker-activity-panel",
            "WorkerActivityPanel",
            worker_activity_panel
        ),
        page!(
            "todo-progress-panel",
            "TodoProgressPanel",
            todo_progress_panel
        ),
        page!("queued-message", "QueuedMessage", queued_message),
        page!(
            "question-answer-card",
            "QuestionAnswerCard",
            question_answer_card
        ),
        page!("event-timeline", "EventTimeline", event_timeline),
        page!("item-card", "ItemCard", item_card),
        page!("chart", "Chart", chart),
        page!("attachment-list", "AttachmentList", attachment_list),
        page!("element-chip", "ElementChip", element_chip),
        page!("artifact-list", "ArtifactList", artifact_list),
        page!("artifact-preview", "ArtifactPreview", artifact_preview),
        page!("changed-line-diff", "ChangedLineDiff", changed_line_diff),
        page!("image-viewer", "ImageViewer", image_viewer),
    ]
}

/// The answer, attachment and artifact blocks (P2-S5).
fn answer_blocks() -> Vec<Page> {
    vec![
        page!("metric-card", "MetricCard", metric_card),
        page!("metric-grid", "MetricGrid", metric_grid),
        page!("progress-meter", "ProgressMeter", progress_meter),
        page!("status-checklist", "StatusChecklist", status_checklist),
        page!("block-columns", "BlockColumns", block_columns),
        page!("block-tabs", "BlockTabs", block_tabs),
        page!("block-action-frame", "BlockActionFrame", block_action_frame),
        page!("notice", "Notice", notice),
    ]
}

/// The composer blocks (P2-S6).
fn composer_blocks() -> Vec<Page> {
    vec![
        page!("composer-card", "ComposerCard", composer_card),
        page!("composer-control", "ComposerControl", composer_control),
        page!(
            "context-donut-button",
            "ContextDonutButton",
            context_donut_button
        ),
        page!(
            "composer-adjunct-panel",
            "ComposerAdjunctPanel",
            composer_adjunct_panel
        ),
        page!(
            "composer-decision-panel",
            "ComposerDecisionPanel",
            composer_decision_panel
        ),
        page!(
            "composer-question-panel",
            "ComposerQuestionPanel",
            composer_question_panel
        ),
        page!("option-menu", "OptionMenu", option_menu),
        page!(
            "filtered-select-popover",
            "FilteredSelectPopover",
            filtered_select_popover
        ),
        page!("suggestion-list", "SuggestionList", suggestion_list),
        page!("split-button", "SplitButton", split_button),
        page!("check-card", "CheckCard", check_card),
        page!("choice-card", "ChoiceCard", choice_card),
        page!("dialog-form", "DialogForm", dialog_form),
        page!("form-section", "FormSection", form_section),
        page!(
            "percent-input-control",
            "PercentInputControl",
            percent_input_control
        ),
        page!("card-list", "CardList", card_list),
        page!("sortable-card-list", "SortableCardList", sortable_card_list),
        page!(
            "settings-action-field",
            "SettingsActionField",
            settings_action_field
        ),
        page!("settings-field", "SettingsField", settings_field),
        page!("settings-header", "SettingsHeader", settings_header),
        page!("settings-nav", "SettingsNav", settings_nav),
        page!(
            "settings-secret-rows",
            "SettingsSecretRows",
            settings_secret_rows
        ),
        page!("settings-section", "SettingsSection", settings_section),
        page!("settings-shell", "SettingsShell", settings_shell),
        page!("setup-wizard-shell", "SetupWizardShell", setup_wizard_shell),
        page!(
            "setup-wizard-step-card",
            "SetupWizardStepCard",
            setup_wizard_step_card
        ),
        page!("tag-color-swatches", "TagColorSwatches", tag_color_swatches),
        page!("tag-field", "TagField", tag_field),
        page!(
            "token-input-control",
            "TokenInputControl",
            token_input_control
        ),
        page!("usage-bars", "UsageBars", usage_bars),
        page!("usage-summary-rows", "UsageSummaryRows", usage_summary_rows),
    ]
}

/// The palette, inspector, new-chat and viewer blocks (P2-S7).
fn s7_blocks() -> Vec<Page> {
    vec![
        page!("command-panel", "CommandPanel", command_panel),
        page!("task-graph-card", "TaskGraphCard", task_graph_card),
        page!("task-graph-detail", "TaskGraphDetail", task_graph_detail),
        page!("task-graph-canvas", "TaskGraphCanvas", task_graph_canvas),
        page!("task-graph-lanes", "TaskGraphLanes", task_graph_lanes),
        page!("task-graph-section", "TaskGraphSection", task_graph_section),
        page!(
            "prompt-suggestion-list",
            "PromptSuggestionList",
            prompt_suggestion_list
        ),
        page!("wallpaper", "Wallpaper", wallpaper),
        page!("tab-strip", "TabStrip", tab_strip),
        page!("breadcrumb", "Breadcrumb", breadcrumb),
        page!("step-sortable-list", "StepSortableList", step_sortable_list),
    ]
}

/// The management blocks (P4).
fn management_blocks() -> Vec<Page> {
    vec![
        page!("activity-feed", "ActivityFeed", activity_feed),
        page!("activity-heatmap", "ActivityHeatmap", activity_heatmap),
        page!("activity-strip", "ActivityStrip", activity_strip),
        page!(
            "automation-run-list",
            "AutomationRunList",
            automation_run_list
        ),
        page!("dashboard-header", "DashboardHeader", dashboard_header),
        page!("document-editor", "DocumentEditor", document_editor),
        page!("group-tile", "GroupTile", group_tile),
        page!("history-row", "HistoryRow", history_row),
        page!("kanban-board", "KanbanBoard", kanban_board),
        page!("library-card", "LibraryCard", library_card),
        page!("management-page", "ManagementPage", management_page),
        page!("mask-canvas", "MaskCanvas", mask_canvas),
        page!("page-container", "PageContainer", page_container),
        page!("section", "Section", section),
        page!("span-bar", "SpanBar", span_bar),
        page!("version-history", "VersionHistory", version_history),
    ]
}

/// The browser blocks (P5-DS).
fn browser_blocks() -> Vec<Page> {
    vec![
        page!("address-field", "AddressField", address_field),
        page!("page-band", "PageBand", page_band),
    ]
}

pub(crate) fn all() -> Vec<Page> {
    let mut pages = primitives();
    pages.extend(blocks());
    pages.extend(answer_blocks());
    pages.extend(composer_blocks());
    pages.extend(s7_blocks());
    pages.extend(management_blocks());
    pages.extend(browser_blocks());
    pages
}

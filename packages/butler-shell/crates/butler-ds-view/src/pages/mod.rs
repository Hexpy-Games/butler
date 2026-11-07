//! The showcase pages: one per B1 primitive, each mirroring its React `*.showcase.tsx`.
mod adaptive_shell;
mod animated_number;
mod artifact_list;
mod artifact_preview;
mod aspect_frame;
mod attached_composer;
mod attachment_list;
mod avatar;
mod block_action_frame;
mod block_columns;
mod block_tabs;
mod bottom_sheet;
mod boxes;
mod breadcrumb;
mod butler_thinking_mark;
mod button;
mod card;
mod changed_line_diff;
mod chart;
mod clickable;
mod collapsible;
mod collapsible_nav_group;
mod command_panel;
mod composer_adjunct_panel;
mod composer_card;
mod composer_control;
mod composer_decision_panel;
mod composer_question_panel;
mod context_donut_button;
mod context_menu;
mod conversation_shell;
mod copy_button;
mod dialog;
mod dialog_contained;
mod disclosure_row;
mod done_icon_button;
mod drag_preview;
mod dropdown_menu;
mod element_chip;
mod empty_line;
mod event_timeline;
mod expandable_text;
mod field;
mod filtered_select_popover;
mod glyph_toggle;
mod grid;
mod icon_button;
mod icon_slot;
mod icon_tile;
mod image_viewer;
mod inline;
mod inline_reference;
mod input;
mod inspector_panel;
mod item_card;
mod kbd;
mod key_value_row;
mod label;
mod layout;
mod list_row;
mod markdown_content;
mod media_frame;
mod message_avatar_block;
mod message_row;
mod meta_list;
mod metric_card;
mod metric_grid;
mod native_select;
mod nav_drop_target;
mod nav_parts;
mod nav_row;
mod nav_section;
mod notice;
mod option_menu;
mod overflow_action_menu;
mod panel_header;
mod pill_button;
mod popover;
mod presence;
mod progress_meter;
mod progress_ring;
mod prompt_suggestion_list;
mod question_answer_card;
mod queued_message;
mod rolling_status_line;
mod rolling_swap;
mod scroll_area;
mod segmented_control;
mod select;
mod separator;
mod sidebar_shell;
mod skeleton;
mod slider;
mod spinner;
mod split_button;
mod stack;
mod status_capsule;
mod status_checklist;
mod success_check;
mod suggestion_list;
mod surface_panel;
mod switch;
mod tab_strip;
mod tabs;
mod tag;
mod task_graph_canvas;
mod task_graph_card;
mod task_graph_detail;
mod task_graph_lanes;
mod task_graph_section;
mod textarea;
mod tinted_glass;
mod titlebar_shell;
mod toast;
mod todo_progress_panel;
mod tooltip;
mod typo;
mod unread_dot;
mod usage_bars;
mod usage_summary_rows;
mod wallpaper;
mod wallpaper_stage;
mod work_activity;
mod worker_activity_panel;
mod worker_activity_row;

use butler_ds::tokens::{Color, Length};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement as _, Styled as _, Window,
    div, px,
};

use crate::app::conversation_bg;
use crate::copy::Lang;

/// One example: its name and how it renders.
pub(crate) struct Story {
    pub(crate) name: &'static str,
    pub(crate) render: fn(Lang, &mut Window, &mut App) -> AnyElement,
}

pub(crate) struct Page {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    pub(crate) stories: fn() -> Vec<Story>,
}

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
    ]
}

pub(crate) fn all() -> Vec<Page> {
    let mut pages = primitives();
    pages.extend(blocks());
    pages.extend(answer_blocks());
    pages.extend(composer_blocks());
    pages.extend(s7_blocks());
    pages
}

/// Forces every story canvas to one width (logical px), so a page can be compared with the React
/// viewer's canvases at their measured width. Unset, a canvas fills its frame.
pub(crate) struct CanvasWidth(pub(crate) f32);

impl gpui::Global for CanvasWidth {}

/// A story's frame (`.frame` > `.preview` > `.canvas` of DesignSystemViewer.module.css).
fn frame(name: &str, content: AnyElement, ds: &Ds, forced: Option<f32>) -> AnyElement {
    let anchor = format!("story-{name}");
    // `.canvas` is a one-column grid with an auto track: its children are grid items, blockified.
    let sized = match forced {
        Some(width) => div().w(px(width)).max_w_full().flex_none(),
        None => div().w_full().min_w_0(),
    }
    .grid()
    .grid_cols(1);
    let canvas = anchor_div(
        sized.child(butler_ds::ui::strut::grid_scope(content)),
        anchor,
    );
    let preview = div()
        .flex()
        .flex_col()
        .justify_center()
        .min_w_0()
        .min_h(px(96.)) // DS: DesignSystemViewer.module.css:305 (6rem)
        .p(ds.len(Length::SpaceMd))
        .border(ds.len(Length::BorderHairline))
        .border_dashed()
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::Surface))
        .child(canvas);
    div()
        .min_w_0()
        .p(ds.len(Length::SpaceLg))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPanel))
        .bg(conversation_bg(ds))
        .text_color(ds.color(Color::TextPrimary))
        .child(preview)
        .into_any_element()
}

/// A child id of a static page id (`(parent, "name")`).
pub(crate) fn sub(parent: &'static str, name: &'static str) -> gpui::ElementId {
    (gpui::ElementId::from(parent), name).into()
}

/// `body` wrapped in a block with a stable geometry selector.
pub(crate) fn anchored(body: AnyElement, name: &str) -> gpui::Div {
    anchor_div(div(), name.to_owned()).child(body)
}

/// A zero-size marker the live harness can look for (`expect anchor <name>`): a story names
/// the value its control holds this way, so a smoke can check what a click or key changed.
pub(crate) fn probe(name: String) -> gpui::Div {
    anchor_div(div().absolute().size_0(), name)
}

/// A stable geometry selector for the screenshot harness (a no-op without `test-support`).
fn anchor_div(el: gpui::Div, name: String) -> gpui::Div {
    el.debug_selector(|| name)
}

/// A page: its title, then the examples.
pub(crate) fn page(
    title: &str,
    stories: Vec<Story>,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut sections = Vec::new();
    for story in stories {
        let content = (story.render)(lang, window, cx);
        let forced = cx.try_global::<CanvasWidth>().map(|width| width.0);
        let ds = Ds::get(cx);
        sections.push(
            Stack::new()
                .gap(Space::Lg)
                .child(Typo::new(Role::PanelSectionTitle, story.name).tone(Tone::Primary))
                .child(frame(story.name, content, ds, forced))
                .into_any_element(),
        );
    }
    // `.content` of DesignSystemViewer.module.css: 3xl xl 4xl, and xl md 3xl on mobile.
    let ds = Ds::get(cx);
    let (top, side, bottom) = if ds.compact() {
        (Length::SpaceXl, Length::SpaceMd, Length::Space3xl)
    } else {
        (Length::Space3xl, Length::SpaceXl, Length::Space4xl)
    };
    div()
        .pt(ds.len(top))
        .pb(ds.len(bottom))
        .px(ds.len(side))
        .child(
            Stack::new()
                .gap(Space::Xxl)
                .child(Typo::new(Role::H1, title.to_owned()))
                .child(
                    Stack::new()
                        .gap(Space::Xxl)
                        .child(Typo::new(Role::H2, "Examples"))
                        .children(sections),
                ),
        )
        .into_any_element()
}

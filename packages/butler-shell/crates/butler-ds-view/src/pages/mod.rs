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
mod card_list;
mod changed_line_diff;
mod chart;
mod check_card;
mod choice_card;
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
mod dialog_form;
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
mod form_section;
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
mod percent_input_control;
mod pill_button;
mod popover;
mod presence;
mod progress_meter;
mod progress_ring;
mod prompt_suggestion_list;
mod provider_logo;
mod question_answer_card;
mod queued_message;
mod registry;
mod rolling_status_line;
mod rolling_swap;
mod scroll_area;
mod segmented_control;
mod select;
mod separator;
mod settings_action_field;
mod settings_field;
mod settings_header;
mod settings_nav;
mod settings_secret_rows;
mod settings_section;
mod settings_shell;
mod setup_wizard_shell;
mod setup_wizard_step_card;
mod sidebar_shell;
mod skeleton;
mod slider;
mod sortable_card_list;
mod spinner;
mod split_button;
mod stack;
mod status_capsule;
mod status_checklist;
mod step_sortable_list;
mod success_check;
mod suggestion_list;
mod surface_panel;
mod switch;
mod tab_strip;
mod tabs;
mod tag;
mod tag_color_swatches;
mod tag_field;
mod task_graph_canvas;
mod task_graph_card;
mod task_graph_detail;
mod task_graph_lanes;
mod task_graph_section;
mod textarea;
mod time_picker;
mod tinted_glass;
mod titlebar_shell;
mod toast;
mod todo_progress_panel;
mod token_input_control;
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

pub(crate) use registry::all;

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

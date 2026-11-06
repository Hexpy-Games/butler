//! The showcase pages: one per B1 primitive, each mirroring its React `*.showcase.tsx`.
mod animated_number;
mod aspect_frame;
mod avatar;
mod bottom_sheet;
mod boxes;
mod button;
mod card;
mod clickable;
mod collapsible;
mod context_menu;
mod copy_button;
mod dialog;
mod dialog_contained;
mod done_icon_button;
mod dropdown_menu;
mod expandable_text;
mod field;
mod glyph_toggle;
mod grid;
mod icon_button;
mod icon_slot;
mod inline;
mod inline_reference;
mod input;
mod kbd;
mod label;
mod layout;
mod media_frame;
mod meta_list;
mod native_select;
mod pill_button;
mod popover;
mod presence;
mod progress_ring;
mod rolling_status_line;
mod rolling_swap;
mod scroll_area;
mod segmented_control;
mod select;
mod separator;
mod skeleton;
mod slider;
mod spinner;
mod stack;
mod success_check;
mod switch;
mod tabs;
mod tag;
mod textarea;
mod tinted_glass;
mod toast;
mod tooltip;
mod typo;
mod unread_dot;

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

pub(crate) fn all() -> Vec<Page> {
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
        page!("rolling-status-line", "RollingStatusLine", rolling_status_line),
        page!("animated-number", "AnimatedNumber", animated_number),
        page!("avatar", "Avatar", avatar),
        page!("expandable-text", "ExpandableText", expandable_text),
        page!("media-frame", "MediaFrame", media_frame),
        page!("inline-reference", "InlineReference", inline_reference),
    ]
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

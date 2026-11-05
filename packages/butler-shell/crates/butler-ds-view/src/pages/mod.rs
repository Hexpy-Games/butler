//! The showcase pages: one per B1 primitive, each mirroring its React `*.showcase.tsx`.
mod boxes;
mod card;
mod grid;
mod inline;
mod kbd;
mod label;
mod layout;
mod presence;
mod separator;
mod stack;
mod tinted_glass;
mod typo;

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
        page!("tinted-glass", "TintedGlass", tinted_glass),
        page!("card", "Card", card),
    ]
}

/// Forces every story canvas to one width (logical px), so a page can be compared with the React
/// viewer's canvases at their measured width. Unset, a canvas fills its frame.
pub(crate) struct CanvasWidth(pub(crate) f32);

impl gpui::Global for CanvasWidth {}

/// A story's frame (`.frame` > `.preview` > `.canvas` of DesignSystemViewer.module.css).
fn frame(name: &str, content: AnyElement, ds: &Ds, forced: Option<f32>) -> AnyElement {
    let anchor = format!("story-{name}");
    let sized = match forced {
        Some(width) => div().w(px(width)).flex_none(),
        None => div().w_full().min_w_0(),
    };
    let canvas = anchor_div(sized.child(content), anchor);
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
    div()
        .p(Ds::get(cx).len(Length::Space3xl))
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

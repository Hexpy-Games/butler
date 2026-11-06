//! DS StatusChecklist (StatusChecklist.tsx / StatusChecklist.module.css): a read-only checklist,
//! CheckCard's round indicator on the first line of each item's text, done items in the
//! secondary tone. Nothing is interactive.
use gpui::{App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window, div};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::typo::{Tone, Typo};

/// One item: its text and whether it is done.
pub struct ChecklistItem {
    text: SharedString,
    done: bool,
}

impl ChecklistItem {
    pub fn new(text: impl Into<SharedString>, done: bool) -> Self {
        Self {
            text: text.into(),
            done,
        }
    }
}

#[derive(IntoElement, Default)]
pub struct StatusChecklist {
    items: Vec<ChecklistItem>,
}

impl StatusChecklist {
    pub fn new(items: impl IntoIterator<Item = ChecklistItem>) -> Self {
        Self {
            items: items.into_iter().collect(),
        }
    }
}

/// CheckIndicator: a hairline ring in the strong line colour; done fills it with the accent and
/// draws the check in the on-accent colour.
fn indicator(done: bool, ds: &Ds) -> gpui::Div {
    let side = ds.len(Length::IconSizeMd);
    let ring = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(side)
        .rounded(ds.len(Length::RadiusPill))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(if done {
            Color::Accent
        } else {
            Color::LineStrong
        }));
    if done {
        ring.bg(ds.color(Color::Accent))
            .text_color(ds.color(Color::PrimaryForeground))
            .child(icon(Icon::CheckIcon, IconSize::Xs, ds))
    } else {
        ring
    }
}

impl RenderOnce for StatusChecklist {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let line = ds.len(Length::TypoBodyLineHeight);
        div()
            .flex()
            .flex_col()
            .gap(ds.len(Length::SpaceSm))
            .children(self.items.into_iter().map(|item| {
                let tone = if item.done {
                    Tone::Secondary
                } else {
                    Tone::Primary
                };
                div()
                    .flex()
                    .items_start()
                    .gap(ds.len(Length::SpaceSm))
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .h(line)
                            .child(indicator(item.done, ds)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Typo::body(item.text).tone(tone)),
                    )
            }))
    }
}

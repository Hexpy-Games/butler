//! DS MetaList (MetaList.tsx / MetaList.module.css): a wrapping run of label/value metadata in
//! caption type ("Input 36,460  Cache 8,200").
use gpui::{App, IntoElement, ParentElement as _, RenderOnce, SharedString, Window};

use super::layout::{Cross, Space, Stack};
use super::typo::{Tone, Typo, Wrap};

/// One entry: a short term (no leading separator or trailing colon; omit it for a value-only
/// entry) and its value.
pub struct MetaItem {
    label: Option<SharedString>,
    value: SharedString,
}

impl MetaItem {
    pub fn new(label: impl Into<SharedString>, value: impl Into<SharedString>) -> Self {
        Self {
            label: Some(label.into()),
            value: value.into(),
        }
    }

    pub fn value(value: impl Into<SharedString>) -> Self {
        Self {
            label: None,
            value: value.into(),
        }
    }
}

#[derive(IntoElement)]
pub struct MetaList {
    items: Vec<MetaItem>,
}

impl MetaList {
    pub fn new(items: impl IntoIterator<Item = MetaItem>) -> Self {
        Self {
            items: items.into_iter().collect(),
        }
    }
}

impl RenderOnce for MetaList {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        // `gap: var(--space-xs) var(--space-md)`: rows xs apart, items md apart.
        let items = self.items.into_iter().map(|item| {
            Stack::row()
                .cross(Cross::Baseline)
                .gap(Space::Xs)
                .children(
                    item.label
                        .map(|label| Typo::caption(label).tone(Tone::Tertiary)),
                )
                .child(
                    Typo::caption(item.value)
                        .tone(Tone::Secondary)
                        .tabular()
                        .wrap(Wrap::Anywhere),
                )
        });
        Stack::row()
            .cross(Cross::Baseline)
            .gap(Space::Md)
            .row_gap(Space::Xs)
            .wrap(true)
            .children(items)
    }
}

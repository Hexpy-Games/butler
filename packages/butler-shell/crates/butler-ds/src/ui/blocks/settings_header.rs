//! DS SettingsHeader (SettingsHeader.tsx / SettingsHeader.module.css): the title row of a
//! settings page: an H2, an optional description capped near 68 characters, an optional
//! secondary line (a subpage breadcrumb) and an optional page action. Below 560px the action
//! drops under the copy.
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::typo::{Tone, Typo};

/// The viewport width at or under which the header stacks (`@media (width <= 560px)`).
const STACK_AT: f32 = 560.; // DS: SettingsHeader.module.css:31
/// The description's `max-width: 68ch`, in body-size ems (`ch` is about half an em).
const DESCRIPTION_CH: f32 = 68.; // DS: SettingsHeader.module.css:15
/// `.secondary { min-height: 28px }`.
const SECONDARY_MIN_HEIGHT: f32 = 28.; // DS: SettingsHeader.module.css:19

#[derive(IntoElement)]
pub struct SettingsHeader {
    title: SharedString,
    description: Option<SharedString>,
    secondary: Option<AnyElement>,
    action: Option<AnyElement>,
}

impl SettingsHeader {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            secondary: None,
            action: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// A subpage's breadcrumb, under the description.
    pub fn secondary(mut self, secondary: impl IntoElement) -> Self {
        self.secondary = Some(secondary.into_any_element());
        self
    }

    /// Not used by settings pages (no page-level actions); for settings-like editors outside
    /// the settings window.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

impl RenderOnce for SettingsHeader {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let max_description = ds.len(Length::FontSize3) * (DESCRIPTION_CH / 2.);
        let copy = Stack::new()
            .gap(Space::Xs)
            .min_width(MinWidth::Zero)
            .child(Typo::h2(self.title).tone(Tone::Primary))
            .children(self.description.map(|text| {
                div()
                    .max_w(max_description)
                    .child(Typo::body(text).tone(Tone::Secondary))
            }))
            .children(
                self.secondary
                    .map(|line| div().min_h(px(SECONDARY_MIN_HEIGHT)).child(line)),
            );
        let stacked = f32::from(window.viewport_size().width) <= STACK_AT;
        let header = if stacked { Stack::new() } else { Stack::row() };
        header
            .gap(Space::Md)
            .cross(if stacked {
                Cross::Stretch
            } else {
                Cross::Start
            })
            .justify(Justify::Between)
            .child(copy)
            .children(self.action.map(|action| div().flex_none().child(action)))
    }
}

//! DS Notice (Notice.tsx / Notice.module.css): an inline status with a tone, an optional icon,
//! title and action. The icon and the action centre on the first line of text.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window,
    div, prelude::FluentBuilder as _, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::icon_slot::{IconSlot, SlotSize};
use crate::ui::typo::{Tone as TypoTone, Typo};

/// `neutral` is a quiet muted status with no colour meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeTone {
    Neutral,
    Info,
    Warning,
    Error,
    Success,
}

#[derive(IntoElement)]
pub struct Notice {
    tone: NoticeTone,
    icon: Option<AnyElement>,
    title: Option<SharedString>,
    message: SharedString,
    action: Option<AnyElement>,
}

impl Notice {
    pub fn new(tone: NoticeTone, message: impl Into<SharedString>) -> Self {
        Self {
            tone,
            icon: None,
            title: None,
            message: message.into(),
            action: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// An action control (a Button); it centres on the first line.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

impl NoticeTone {
    /// Fill, border and text colours.
    fn colors(self) -> (Color, Color, Color) {
        match self {
            Self::Neutral => (Color::Muted, Color::Line, Color::TextSecondary),
            Self::Info => (
                Color::ColorInfoBg,
                Color::ColorInfoBorder,
                Color::ColorInfoText,
            ),
            Self::Warning => (
                Color::ColorWarningBg,
                Color::ColorWarningBorder,
                Color::ColorWarningText,
            ),
            Self::Error => (
                Color::ColorDangerBg,
                Color::ColorDangerBorder,
                Color::ColorDangerText,
            ),
            Self::Success => (
                Color::ColorSuccessBg,
                Color::ColorSuccessBorder,
                Color::ColorSuccessText,
            ),
        }
    }
}

impl RenderOnce for Notice {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (fill, border, text) = self.tone.colors();
        let space = |token| ds.len(token);
        let (label_size, label_line) = (
            ds.len(Length::TypoLabelSize),
            ds.len(Length::TypoLabelLineHeight),
        );
        let body_line = ds.len(Length::TypoBodyLineHeight);
        // `.notice:has(> .action)`: room for a control taller than the line.
        let action_pad = self.action.as_ref().map_or(px(0.), |_| {
            ((ds.len(Length::ControlHeightSm) - body_line) / 2.).max(px(0.))
        });
        let titled = self.title.is_some();
        let mut message = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(space(Length::SpaceXs))
            .text_size(ds.len(Length::FontSize2))
            .line_height(label_line);
        if let Some(title) = self.title {
            message = message.child(Typo::label(title).tone(TypoTone::Inherit));
        }
        message = message.child(Typo::body(self.message).tone(TypoTone::Inherit));
        let mut lead = div()
            .flex()
            .flex_1()
            .items_start()
            .min_w_0()
            .gap(space(Length::SpaceSm));
        if let Some(glyph) = self.icon {
            // `.notice:has(.title) .icon`: the slot's line is the label's.
            let slot = div()
                .when(titled, |slot| {
                    slot.text_size(label_size).line_height(label_line)
                })
                .child(IconSlot::new().size(SlotSize::Md).min_line().child(glyph));
            lead = lead.child(slot);
        }
        let mut row = div()
            .flex()
            .items_start()
            .gap(space(Length::SpaceSm))
            .px(space(Length::SpaceMd))
            .py(space(Length::SpaceSm) + action_pad)
            .rounded(space(Length::RadiusControl))
            .border(space(Length::BorderHairline))
            .border_color(ds.color(border))
            .bg(ds.color(fill))
            .text_color(ds.color(text))
            .text_size(space(Length::TypoBodySize))
            .line_height(body_line)
            .child(lead.child(message));
        if let Some(action) = self.action {
            row = row.child(
                // `align-items: center` in a `1lh` box: a control taller than the line overhangs
                // both ends (a column's main-axis centring does that, a row's cross axis does not).
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .justify_center()
                    .h(body_line)
                    .child(action),
            );
        }
        row
    }
}

//! The header: the moment row, the title icon, the title and the description
//! (`PromptSuggestionList.tsx:92-135`, `.header` ... `.description` of the CSS).
use gpui::{
    AnyElement, App, Div, IntoElement as _, ParentElement as _, Pixels, Styled as _, div, px,
};

use super::content_rect::{Recording, Slot};
use super::metrics::Metrics;
use super::text::{Face, run};
use super::{PromptSuggestionList, TitleIcon};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::{Ds, keep_words};
use crate::ui::typo::{Tone, Typo};

/// The three-dot marker's size and dot spacing.
const DOTS_WIDTH: f32 = 38.; // DS: PromptSuggestionList.module.css:72
const DOTS_HEIGHT: f32 = 8.; // DS: PromptSuggestionList.module.css:73
const DOT_PITCH: f32 = 15.; // DS: PromptSuggestionList.module.css:77-90
/// The description's measure.
const DESCRIPTION_MAX: f32 = 560.; // DS: PromptSuggestionList.module.css:150

/// `.moment::before`: three dots in the primary, secondary and strong line colours.
fn dots(ds: &Ds) -> Div {
    let dot = |index: f32, color: Color| {
        div()
            .absolute()
            .top_0()
            .left(px(index * DOT_PITCH))
            .size(px(DOTS_HEIGHT))
            .rounded_full()
            .bg(ds.color(color))
    };
    div()
        .relative()
        .flex_none()
        .w(px(DOTS_WIDTH))
        .h(px(DOTS_HEIGHT))
        .child(dot(0., Color::TextPrimary))
        .child(dot(1., Color::TextSecondary))
        .child(dot(2., Color::LineStrong))
}

/// The dots and the time, in the label weight, upper case.
fn moment(text: &str, ds: &Ds, cx: &App) -> Div {
    let face = Face {
        size: Length::TypoCaptionSize,
        line_height: Length::TypoCaptionLineHeight,
        weight: ds.number(Number::TypoLabelWeight),
        letter_spacing: 0.,
    };
    div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .text_color(ds.color(Color::TextSecondary))
        .child(dots(ds))
        .child(run(&face, text.to_uppercase(), ds, cx))
}

/// The title: the new-chat title tokens, words kept together.
fn title(list: &PromptSuggestionList, m: &Metrics, ds: &Ds, cx: &App) -> Div {
    let face = Face {
        size: m.title_size,
        line_height: m.title_line,
        weight: ds.number(Number::TypoNewChatTitleWeight),
        letter_spacing: ds.number(Number::TypoNewChatTitleLetterSpacing),
    };
    keep_words(run(&face, list.title.clone(), ds, cx).text_color(ds.color(Color::TextPrimary)))
}

fn icon_box(icon: &TitleIcon, side: f32, ds: &Ds) -> Div {
    let side: Pixels = px(side);
    div()
        .flex_none()
        .size(side)
        .text_color(ds.color(Color::TextPrimary))
        .child(icon(side))
}

/// The row of the title and its description, with the icon in the margin beside it.
fn title_row(list: &PromptSuggestionList, m: &Metrics, ds: &Ds, cx: &App) -> Div {
    let mut copy = div()
        .flex()
        .flex_col()
        .min_w_0()
        .gap(ds.len(m.copy_gap))
        .child(title(list, m, ds, cx));
    if let Some(description) = &list.description {
        copy = copy.child(
            div()
                .max_w(px(DESCRIPTION_MAX))
                .child(Typo::body(description.clone()).tone(Tone::Secondary)),
        );
    }
    let mut row = div().relative().w_full().min_w_0();
    if let Some(icon) = list.title_icon.as_ref().filter(|_| !m.compact) {
        row = row.min_h(px(m.icon_size)).child(
            icon_box(icon, m.icon_size, ds)
                .absolute()
                .top_0()
                .left(px(-(m.icon_size + m.icon_gap))),
        );
    }
    row.child(copy)
}

/// The header block, centred in the list.
pub(super) fn render(
    list: &PromptSuggestionList,
    m: &Metrics,
    recording: Option<&Recording>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let mut header = div()
        .relative()
        .flex()
        .flex_col()
        .w_full()
        .max_w(px(m.content_width.max(0.)))
        .gap(ds.len(Length::SpaceMd));
    let compact_icon = list.title_icon.as_ref().filter(|_| m.compact);
    if list.moment.is_some() || compact_icon.is_some() {
        header = header.child(
            div()
                .flex()
                .items_center()
                .min_w_0()
                .gap(ds.len(Length::SpaceSm))
                .children(compact_icon.map(|icon| icon_box(icon, m.icon_size, ds)))
                .children(list.moment.as_ref().map(|text| moment(text, ds, cx))),
        );
    }
    header = header
        .child(title_row(list, m, ds, cx))
        .children(recording.map(|recording| recording.record(Slot::Header)));
    div()
        .flex()
        .justify_center()
        .w_full()
        .px(px(m.edge_gutter))
        .child(header)
        .into_any_element()
}

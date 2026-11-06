//! Stand-ins for DS components and blocks that arrive in later batches (ProgressMeter,
//! SettingsSection, SettingsField, LoadingIndicator). They only let
//! the showcases that use them (Layout, Inline, Label, Clickable, ...) render their layout;
//! each draws from tokens, follows the React CSS it replaces, and goes away when its primitive
//! lands. They are not part of `butler-ds`.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement, ParentElement as _, Styled as _, div};

/// ProgressMeter `bare`: a 4px track filled to `value` percent.
pub(crate) fn progress_bare(value: f32, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .w_full()
        .h(ds.len(Length::SpaceXs))
        .overflow_hidden()
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Selection))
        .child(
            div()
                .h_full()
                .w(gpui::relative(value / 100.))
                .bg(ds.color(Color::Accent)),
        )
        .into_any_element()
}

/// SettingsSection `kind="status"`: the title above a bordered card.
pub(crate) fn settings_status(title: &'static str, body: AnyElement, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    Stack::new()
        .gap(Space::Md)
        .child(Typo::h4(title))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(ds.len(Length::SpaceMd))
                .min_w_0()
                .p(settings_padding(ds))
                .border(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::Line))
                .rounded(ds.len(Length::RadiusPanel))
                .bg(ds.color(Color::SettingsPanelBg))
                .child(body),
        )
        .into_any_element()
}

/// `--settings-section-padding`: `--space-lg` in a compact settings shell (`width <= 760px`,
/// tokens.css:1095), a media query the token tables do not carry.
fn settings_padding(ds: &Ds) -> gpui::Pixels {
    if ds.tokens().viewport.0 <= 760. {
        ds.len(Length::SpaceLg)
    } else {
        ds.len(Length::SettingsSectionPadding)
    }
}

/// SettingsField (stacked): the label and description above the control column
/// (`min(100%, 460px)`), inside a SettingsSection.
pub(crate) fn settings_field(
    label: &'static str,
    description: &'static str,
    control: AnyElement,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    Stack::new()
        .gap(Space::Sm)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(ds.len(Length::SettingsFieldCopyGap))
                .max_w(gpui::px(608.)) // DS: SettingsField.module.css:22 (38rem)
                .child(butler_ds::ui::label::Label::new().child(label))
                .child(Typo::caption(description).tone(Tone::Secondary)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .w_full()
                .max_w(gpui::px(460.)) // DS: SettingsField.module.css:28
                .child(control),
        )
        .into_any_element()
}

/// LoadingIndicator: the Spinner while loading, the ringed success check once done.
pub(crate) fn loading_indicator(
    id: impl Into<gpui::ElementId>,
    loading: bool,
    size: f32,
) -> AnyElement {
    let id = id.into();
    if loading {
        butler_ds::ui::spinner::Spinner::new(id)
            .size(size)
            .into_any_element()
    } else {
        butler_ds::ui::success_check::SuccessCheck::new(id)
            .ring()
            .size(size)
            .into_any_element()
    }
}

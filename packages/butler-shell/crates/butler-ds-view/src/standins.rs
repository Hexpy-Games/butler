//! Stand-ins for DS components and blocks that arrive in later batches (Tag, Input, ListRow,
//! ProgressMeter, SettingsSection). They only let
//! the showcases that use them (Layout, Inline, Label, Clickable, ...) render their layout;
//! each draws from tokens, follows the React CSS it replaces, and goes away when its primitive
//! lands. They are not part of `butler-ds`.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack, WithItem as _};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement, ParentElement as _, Styled as _, div};

/// Tag (Tag.module.css, `size="sm"`, neutral): a pill chip.
pub(crate) fn tag(text: impl Into<gpui::SharedString>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let size = ds.len(Length::FontSize1);
    div()
        .flex()
        .items_center()
        .w_auto()
        .min_h(ds.len(Length::TagHeightSm))
        .py(ds.len(Length::TagPaddingBlock))
        .px(ds.len(Length::TagPaddingInlineSm))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Surface))
        .text_color(ds.color(Color::TextSecondary))
        .font_family(ds.body_font().clone())
        .text_size(size)
        .line_height(ds.len(Length::TypoCaptionLineHeightTight))
        .child(text.into())
        .into_any_element()
}

/// Input (default variant) showing a placeholder: a bordered field of the default height.
pub(crate) fn input_placeholder(text: impl Into<gpui::SharedString>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let size = ds.len(Length::FontSize3);
    div()
        .flex()
        .items_center()
        .w_full()
        .h(ds.len(Length::ControlHeightMd))
        .px(gpui::px(10.))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::SurfaceRaised))
        .text_color(ds.color(Color::Placeholder))
        .font_family(ds.body_font().clone())
        .text_size(size)
        .line_height(size)
        .child(text.into())
        .into_any_element()
}

/// ListRow (ListRow.module.css): an optional icon, the title with its meta, a description.
pub(crate) fn list_row(
    icon: Option<AnyElement>,
    title: &'static str,
    description: Option<&'static str>,
    meta: Option<&'static str>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let heading = div()
        .flex()
        .flex_wrap()
        .items_center()
        .justify_between()
        .gap_x(ds.len(Length::SpaceMd))
        .gap_y(ds.len(Length::SpaceXs))
        .child(
            div().flex_1().min_w_0().child(
                Typo::body(title)
                    .truncate()
                    .weight(butler_ds::ui::typo::Weight::Regular),
            ),
        )
        .children(meta.map(|meta| Typo::caption(meta).tone(Tone::Tertiary)));
    let content = Stack::new()
        .gap(Space::Xs)
        .min_width(butler_ds::ui::layout::MinWidth::Zero)
        .child(heading)
        .children(description.map(|text| Typo::caption(text).tone(Tone::Secondary)));
    let mut row = div()
        .flex()
        .w_full()
        .items_start()
        .gap(ds.len(Length::Space2))
        .p(ds.len(Length::Space2));
    if let Some(icon) = icon {
        row = row.child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .h(ds.len(Length::TypoBodyLineHeight))
                .text_color(ds.color(Color::TextTertiary))
                .child(icon),
        );
    }
    row.child(div().flex_1().min_w_0().child(content))
        .into_any_element()
}

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
                .p(ds.len(Length::SettingsSectionPadding))
                .border(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::Line))
                .rounded(ds.len(Length::RadiusPanel))
                .bg(ds.color(Color::SettingsPanelBg))
                .child(body),
        )
        .into_any_element()
}

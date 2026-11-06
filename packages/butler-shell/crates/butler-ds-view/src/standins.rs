//! Stand-ins for DS components and blocks that arrive in later batches (Tag, Input, ListRow,
//! ProgressMeter, SettingsSection, Field, SettingsField, LoadingIndicator, DisclosureRow). They only let
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
            // `flex: 1 1 50%`: the title keeps half the line, so a long meta wraps below it.
            div()
                .flex_grow(1.)
                .flex_shrink(1.)
                .flex_basis(gpui::relative(0.5))
                .min_w_0()
                .child(
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

/// Field (vertical): its children stacked by `--space-2`.
pub(crate) fn field(children: Vec<AnyElement>, cx: &App) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(Ds::get(cx).len(Length::Space2))
        .children(children)
        .into_any_element()
}

/// FieldLabel: a Label (`min-height: 18px`) on the label line height, which steps up on mobile.
pub(crate) fn field_label(text: impl Into<gpui::SharedString>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .flex()
        .items_center()
        .gap(ds.len(Length::Space2))
        .min_h(gpui::px(18.)) // DS: Label.module.css:3
        .text_color(ds.color(Color::TextPrimary))
        .font_family(ds.body_font().clone())
        .text_size(ds.len(Length::FontSize3))
        .font_weight(gpui::FontWeight(
            ds.number(butler_ds::tokens::Number::FontWeightMedium),
        ))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .child(text.into())
        .into_any_element()
}

/// FieldDescription: `--font-size-3` on the body line, `--text-secondary`.
pub(crate) fn field_description(text: impl Into<gpui::SharedString>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .text_size(ds.len(Length::FontSize3))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .text_color(ds.color(Color::TextSecondary))
        .child(text.into())
        .into_any_element()
}

/// Field `orientation="horizontal"` with a content column: the label and description at the
/// start, the control at the row end centred on the label's line (`control_height` tall).
pub(crate) fn field_row(
    label: AnyElement,
    description: AnyElement,
    control: AnyElement,
    control_height: f32,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .flex()
        .items_start()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::Space2))
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .gap(gpui::px(2.)) // DS: Field.module.css:53
                .child(
                    div()
                        .flex()
                        .items_center()
                        .min_h(gpui::px(control_height))
                        .child(label),
                )
                .child(description),
        )
        .child(
            div()
                .flex()
                .items_center()
                .h(gpui::px(control_height))
                .child(control),
        )
        .into_any_element()
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

/// DisclosureRow (DisclosureRow.module.css, `surface="selection"`, trailing chevron): a stretched
/// Clickable with the icon, the title and a chevron that turns down when open, filled with
/// `--selection` while open, over a Collapsible panel indented under the title.
pub(crate) fn disclosure_row(
    id: &'static str,
    glyph: butler_ds::ui::Icon,
    title: &'static str,
    open: bool,
    body: AnyElement,
    toggle: impl Fn(&mut App) + 'static,
    cx: &App,
) -> AnyElement {
    use butler_ds::ui::clickable::Clickable;
    use butler_ds::ui::collapsible::Collapsible;
    use butler_ds::ui::icon::{IconSize, icon};
    let ds = Ds::get(cx);
    let (inset, line, gap) = (
        ds.len(Length::SpaceSm),
        ds.len(Length::TypoBodyLineHeight),
        ds.len(Length::SpaceSm),
    );
    let chevron = if open {
        butler_ds::ui::Icon::ChevronDown
    } else {
        butler_ds::ui::Icon::ChevronRight
    };
    let trigger = Clickable::new(id)
        .stretch()
        .on_click(move |_, _, cx| toggle(cx))
        .child(
            div()
                .flex()
                .w_full()
                .items_start()
                .gap(gap)
                .p(inset)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(line)
                        .flex_none()
                        .text_color(ds.color(Color::TextTertiary))
                        .child(icon(glyph, IconSize::Md, ds)),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(ds.len(Length::SpaceXs))
                        .min_w_0()
                        .child(Typo::body(title).truncate())
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .h(line)
                                .text_color(ds.color(Color::TextTertiary))
                                .child(icon(chevron, IconSize::Sm, ds)),
                        ),
                ),
        );
    let panel = div()
        .pb(inset)
        .pr(inset)
        .pl(inset + line + gap)
        .text_color(ds.color(Color::TextSecondary))
        .child(body);
    let mut row = div().rounded(ds.len(Length::RadiusControl));
    if open {
        row = row.bg(ds.color(Color::Selection));
    }
    row.child(trigger)
        .child(Collapsible::new(gpui::SharedString::from(format!("{id}-panel")), open).child(panel))
        .into_any_element()
}

//! Stand-ins for DS components that arrive in later batches (Tag, Button, Input). They only let
//! the B1 showcases that use them (Presence, Stack, Kbd, Grid, Card, ...) render their layout;
//! each draws from tokens, follows the React CSS it replaces, and goes away when its primitive
//! lands. They are not part of `butler-ds`.
use butler_ds::tokens::{Color, Length, Number};
use butler_ds::ui::context::Ds;
use butler_ds::ui::convert;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
};

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

/// Button `variant="outline"` (Button.module.css): the default size, or `sm`.
pub(crate) fn outline_button(
    id: impl Into<ElementId>,
    text: impl Into<gpui::SharedString>,
    small: bool,
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let height = ds.len(if small {
        Length::ControlHeightSm
    } else {
        Length::ControlHeightMd
    });
    let size = ds.len(Length::FontSize3);
    let raised = ds.color(Color::SurfaceRaised);
    div()
        .id(id)
        .flex()
        .flex_none()
        .self_start()
        .items_center()
        .justify_center()
        .gap(gpui::px(5.)) // DS: Button.module.css:10
        .h(height)
        .px(gpui::px(10.)) // DS: Button.module.css:11
        .border(gpui::px(1.)) // DS: Button.module.css:61
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusControl))
        .bg(convert::with_alpha(raised, 0.86)) // DS: Button.module.css:62
        .text_color(ds.color(Color::TextPrimary))
        .font_family(ds.body_font().clone())
        .text_size(size)
        .line_height(size)
        .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
        .cursor_pointer()
        .on_click(on_click)
        .children(leading)
        .child(text.into())
        .children(trailing)
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

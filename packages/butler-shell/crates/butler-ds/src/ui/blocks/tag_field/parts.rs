//! The TagField's parts: the typing point, a completion row, the key handling and the field box.
use std::rc::Rc;

use gpui::{
    AnyElement, Div, ElementId, InteractiveElement as _, IntoElement as _, KeyDownEvent,
    MouseButton, ParentElement as _, SharedString, Styled as _, Window, div, px,
};
use gpui_elements::editable_text::actions::{DeleteLeft, Enter, NavDown, NavUp};

use super::{Ctx, Labeler, Row};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::tag::Tag;
use crate::ui::text::{Textarea, TextareaVariant};
use crate::ui::{Icon, convert, focus};

/// The typing point: the bare editor, one line tall, filling what the chips leave.
fn input(id: ElementId, ctx: &Rc<Ctx>, placeholder: Option<SharedString>, ds: &Ds) -> AnyElement {
    let change = ctx.clone();
    let mut editor = Textarea::new(id)
        .variant(TextareaVariant::Bare)
        .on_change(move |text, window, cx| change.typed(text, window, cx));
    if let Some(placeholder) = placeholder {
        editor = editor.placeholder(placeholder);
    }
    div()
        .flex()
        .flex_1()
        .items_center()
        .min_w(px(96.)) // DS: TagField.module.css:34 (6rem)
        .h(ds.len(Length::TagHeightSm))
        .px(ds.len(Length::SpaceXs))
        .text_size(ds.len(Length::FontSize3))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .text_color(ds.color(Color::TextPrimary))
        .child(div().w_full().child(editor))
        .into_any_element()
}

/// One completion row; the pointer highlights it, a press adds it and keeps focus in the field.
pub(super) fn option(
    id: &ElementId,
    index: usize,
    row: Row,
    active: bool,
    label: &Labeler,
    ctx: &Rc<Ctx>,
    ds: &Ds,
) -> AnyElement {
    let (glyph, text) = if row.create {
        (Icon::Plus, label(&row.name[..]))
    } else {
        (Icon::TagIcon, row.name.clone())
    };
    let (hover, press, name) = (ctx.clone(), ctx.clone(), row.name);
    let mut el = div()
        .id((id.clone(), SharedString::from(format!("option-{index}"))))
        .flex()
        .items_center()
        .min_w_0()
        .h(ds.len(Length::MenuItemHeight))
        .px(ds.len(Length::SpaceSm))
        .gap(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::RadiusControl))
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize2))
        .cursor_pointer()
        .on_mouse_move(move |_, _, cx| {
            if *hover.active.read(cx) != index {
                hover.active.update(cx, |active, cx| {
                    *active = index;
                    cx.notify();
                });
            }
        })
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            press.add(&name, window, cx);
            press.handle.focus(window, cx);
        })
        .child(
            div()
                .flex_none()
                .text_color(ds.color(Color::TextSecondary))
                .child(icon(glyph, IconSize::Sm, ds)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(text),
        );
    if active {
        el = el.bg(ds.color(Color::Selection));
    }
    if let Some(count) = row.count {
        el = el.child(
            div()
                .text_color(ds.color(Color::TextTertiary))
                .text_size(ds.len(Length::FontSize1))
                .child(count.to_string()),
        );
    }
    el.into_any_element()
}

/// Enter, Up, Down, Backspace on an empty field and Escape, ahead of the editor's own handling.
fn keys(field: Div, ctx: &Rc<Ctx>) -> Div {
    field
        .capture_action({
            let ctx = ctx.clone();
            move |_: &Enter, window, cx| {
                if ctx.composing(window, cx) {
                    return;
                }
                cx.stop_propagation();
                ctx.commit(&ctx.query(cx), window, cx);
            }
        })
        .capture_action({
            let ctx = ctx.clone();
            move |_: &NavDown, window, cx| {
                if ctx.composing(window, cx) {
                    return;
                }
                cx.stop_propagation();
                ctx.step(false, cx);
            }
        })
        .capture_action({
            let ctx = ctx.clone();
            move |_: &NavUp, window, cx| {
                if ctx.composing(window, cx) {
                    return;
                }
                cx.stop_propagation();
                ctx.step(true, cx);
            }
        })
        .capture_action({
            let ctx = ctx.clone();
            move |_: &DeleteLeft, window, cx| {
                if !ctx.composing(window, cx) && ctx.query(cx).is_empty() && !ctx.value.is_empty() {
                    cx.stop_propagation();
                    ctx.remove_last(window, cx);
                }
            }
        })
        .capture_key_down({
            let ctx = ctx.clone();
            move |event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && !ctx.query(cx).is_empty() {
                    cx.stop_propagation();
                    ctx.clear(cx);
                }
            }
        })
}

/// The bordered field: chips, then the typing point; the border mixes in the accent on focus.
pub(super) fn field(
    input_id: ElementId,
    placeholder: Option<SharedString>,
    tags: Vec<Tag>,
    ctx: &Rc<Ctx>,
    window: &mut Window,
    ds: &Ds,
) -> Div {
    let placeholder = ctx.value.is_empty().then_some(placeholder).flatten();
    let line = ds.color(Color::Line);
    let focused = ctx.handle.is_focused(window);
    let border = if focused {
        convert::mix(ds.color(Color::Accent), line, 0.52) // DS: TagField.module.css:29
    } else {
        line
    };
    let mut field = div()
        .flex()
        .flex_wrap()
        .items_center()
        .min_w_0()
        .min_h(px(36.)) // DS: TagField.module.css:17
        .p(ds.len(Length::SpaceXs))
        .gap(ds.len(Length::SpaceXs))
        .border(ds.len(Length::BorderHairline))
        .border_color(border)
        .rounded(ds.len(Length::RadiusControl))
        .bg(convert::with_alpha(ds.color(Color::SurfaceRaised), 0.92)) // DS: TagField.module.css:25
        .children(tags)
        .child(input(input_id, ctx, placeholder, ds));
    if focused {
        field = field.shadow(focus::shadows(ds));
    }
    keys(field, ctx)
}

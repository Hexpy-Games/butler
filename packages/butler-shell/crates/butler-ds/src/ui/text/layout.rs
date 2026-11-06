//! How a field is put together around its editor: the bordered box (default and quiet), the
//! underline, and the line-snapped underline textarea with its scroll fade.
use gpui::{
    AnyElement, App, Div, Entity, InteractiveElement as _, IntoElement as _, OverflowWrap,
    ParentElement as _, Pixels, ScrollHandle, StatefulInteractiveElement as _, Styled, Window, div,
    px,
};
use gpui_elements::editable_text::{EditableTextElement, text_area, text_input};

use super::field::{Look, Parts, Shape};
use super::reveal;
use crate::tokens::{Length, Number};
use crate::ui::context::{Ds, Lang, keep_words};
use crate::ui::scroll::{self, Axis, Config};
use crate::ui::{control, convert, focus};

/// `padding: 9px 10px` of the bordered textarea (DS: Textarea.module.css:4).
const AREA_PAD: [f32; 2] = [9., 10.];
/// `min-height: 140px` of the bordered textarea (DS: Textarea.module.css:3).
const AREA_MIN_HEIGHT: f32 = 140.;
/// `width: 5.5rem` of the compact input (DS: Input.module.css:25).
const COMPACT_WIDTH_REM: f32 = 5.5;
/// Side padding of the default input (DS: Input.module.css:5).
const INPUT_PAD_X: f32 = 10.;

pub(super) fn build(
    p: &Parts,
    hover: &Entity<bool>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match (p.spec.look, p.spec.shape) {
        (Look::Underline, Shape::Line { .. }) => underline_line(p, hover, cx),
        (Look::Underline, Shape::Area { .. }) => underline_area(p, window, cx),
        (_, Shape::Line { compact }) => boxed_line(p, compact, window, cx),
        (_, Shape::Area { rows, grow }) => boxed_area(p, rows, grow, cx),
    }
}

/// How the editor (or the plain text of a disabled field) is sized and padded.
#[derive(Default)]
struct Sizing {
    pad: [Pixels; 4],
    height: Option<Pixels>,
    min_height: Option<Pixels>,
    max_height: Option<Pixels>,
    fill_height: bool,
    /// Placed over the top of its box, one line tall.
    pinned: bool,
}

fn apply<E: Styled>(mut el: E, s: &Sizing) -> E {
    el = el
        .w_full()
        .pl(s.pad[0])
        .pt(s.pad[1])
        .pr(s.pad[2])
        .pb(s.pad[3]);
    if let Some(h) = s.height {
        el = el.h(h);
    }
    if let Some(h) = s.min_height {
        el = el.min_h(h);
    }
    if let Some(h) = s.max_height {
        el = el.max_h(h);
    }
    if s.fill_height {
        el = el.h_full();
    }
    if s.pinned {
        el = el.absolute().top_0().left_0().right_0();
    }
    el
}

/// A multi-line field's break rules: `:lang(ko)`'s keep-all and the textarea's `break-word`
/// (UnderlineField.module.css:83: the underline field breaks `anywhere`).
fn wrapping<E: Styled>(el: E, p: &Parts, ds: &Ds) -> E {
    let el = if ds.lang() == Lang::Ko {
        keep_words(el)
    } else {
        el.overflow_wrap(OverflowWrap::BreakWord)
    };
    if p.spec.look == Look::Underline {
        el.overflow_wrap(OverflowWrap::Anywhere)
    } else {
        el
    }
}

fn editable(p: &Parts, ds: &Ds) -> EditableTextElement {
    let multiline = matches!(p.spec.shape, Shape::Area { .. });
    let id = (p.spec.id.clone(), "edit");
    let mut el = if multiline {
        text_area(id).overflow_y_scroll()
    } else {
        text_input(id).whitespace_nowrap().overflow_x_scroll()
    }
    .state(p.state.downgrade())
    .placeholder_color(p.c.placeholder)
    .selection_color(convert::with_alpha(
        ds.color(crate::tokens::Color::Accent),
        0.28,
    ))
    .caret_color(p.c.text)
    .marked_color(p.c.text)
    .caret_w(px(1.))
    .accepts_input(!p.spec.read_only)
    .text_color(p.c.text)
    .text_size(p.m.size)
    .line_height(p.m.lh);
    if let Some(weight) = p.m.weight {
        el = el.font_weight(weight);
    }
    if multiline {
        el = wrapping(el, p, ds);
    }
    if let Some(placeholder) = &p.spec.placeholder {
        el = el.placeholder(placeholder.clone());
    }
    if !ds.reduced_motion() {
        el = el.caret_blink_interval_500ms();
    }
    el
}

/// A disabled field: its text (or placeholder), no editor.
fn plain_text(p: &Parts, ds: &Ds, cx: &App) -> Div {
    let text = p.state.read(cx).as_str().to_owned();
    let (shown, color) = if text.is_empty() {
        (
            p.spec.placeholder.clone().unwrap_or_default(),
            p.c.placeholder,
        )
    } else {
        (text.into(), p.c.text)
    };
    let el = div()
        .overflow_hidden()
        .cursor_not_allowed()
        .text_color(color)
        .text_size(p.m.size)
        .line_height(p.m.lh);
    let el = match p.m.weight {
        Some(weight) => el.font_weight(weight),
        None => el,
    };
    match p.spec.shape {
        Shape::Line { .. } => el.whitespace_nowrap().text_ellipsis().child(shown),
        Shape::Area { .. } => wrapping(el, p, ds).child(shown),
    }
}

fn editor(p: &Parts, s: &Sizing, scroll: Option<&ScrollHandle>, cx: &App) -> AnyElement {
    if p.spec.disabled {
        return apply(plain_text(p, Ds::get(cx), cx), s).into_any_element();
    }
    let el = apply(editable(p, Ds::get(cx)), s);
    match scroll {
        Some(handle) => el.track_scroll(handle).into_any_element(),
        None => el.into_any_element(),
    }
}

/// The field's tab stop. The editor's own focus handle is not one, so a zero-size element
/// tracks it and registers it in the tab order (Tab reaches a text field as it does in React).
/// It comes before the editor, so the editor's key context stays the one the handle resolves to.
fn tab_stop(p: &Parts) -> Option<Div> {
    (!p.spec.disabled).then(|| div().absolute().size_0().track_focus(&p.handle))
}

/// The box behind a bordered field: fill and border, and the ring around it.
fn surface(p: &Parts, cx: &App) -> (Div, Option<Div>) {
    let ds = Ds::get(cx);
    let fill = div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(p.m.radius)
        .bg(p.c.fill)
        .border(p.m.border)
        .border_color(p.c.border);
    let ring = p
        .ring
        .then(|| control::ring_layer(focus::shadows(ds), p.m.radius));
    (fill, ring)
}

/// The anchor, the ring's published box and the frame of a bordered field.
fn boxed(p: &Parts, frame: Div, editor: AnyElement, cx: &App) -> AnyElement {
    let (fill, ring) = surface(p, cx);
    let room = focus::room(Ds::get(cx));
    let anchor = p.anchor.clone();
    frame
        .relative()
        .debug_selector(move || anchor.to_string())
        .child(fill)
        .children(ring)
        .children(tab_stop(p))
        .child(editor)
        .children(p.focused.then(|| focus::publish(p.handle.clone(), room)))
        .into_any_element()
}

fn boxed_line(p: &Parts, compact: bool, window: &Window, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let hit = ds.len(Length::ControlHitTarget);
    let (floor, pad_x, pad_y) = if compact {
        (
            ds.len(Length::ControlHeightSm),
            ds.len(Length::SpaceSm),
            ds.len(Length::SpaceXs),
        )
    } else {
        (ds.len(Length::ControlHeightLg), px(INPUT_PAD_X), px(0.))
    };
    let floor = if ds.compact() { floor.max(hit) } else { floor };
    // The default field is exactly `--control-height-lg`; the compact one is as tall as its line.
    let natural = p.m.lh + (p.m.border + pad_y) * 2.;
    let height = if compact { natural.max(floor) } else { floor };
    let vertical = ((height - p.m.lh) / 2.).max(p.m.border + pad_y);
    let side = p.m.border + pad_x;
    let sizing = Sizing {
        pad: [side, vertical, side, vertical],
        fill_height: true,
        ..Sizing::default()
    };
    let frame = if compact {
        div().w(window.rem_size() * COMPACT_WIDTH_REM).flex_none()
    } else {
        div().w_full()
    };
    boxed(p, frame.h(height), editor(p, &sizing, None, cx), cx)
}

fn boxed_area(p: &Parts, rows: Option<u32>, grow: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let pad = [px(AREA_PAD[1]) + p.m.border, px(AREA_PAD[0]) + p.m.border];
    let frame_h = pad[1] * 2.;
    let min = px(AREA_MIN_HEIGHT);
    let mut sizing = Sizing {
        pad: [pad[0], pad[1], pad[0], pad[1]],
        min_height: Some(min),
        ..Sizing::default()
    };
    if grow {
        let lines = ds.number(Number::TextareaGrowMaxLines);
        sizing.max_height = Some(p.m.lh * lines + frame_h);
    } else {
        let rows = rows.map_or(px(0.), |rows| p.m.lh * rows as f32 + frame_h);
        sizing.height = Some(min.max(rows));
    }
    boxed(p, div().w_full(), editor(p, &sizing, None, cx), cx)
}

/// The underline: one line tall in the flow, its line drawn `1px` below (`2px` while focused)
/// into the room the field reserves under itself.
fn line_under(p: &Parts, top: Pixels) -> Div {
    let (offset, thickness) = if p.focused {
        (px(0.), p.m.ring)
    } else {
        (px(1.), p.m.border)
    };
    div()
        .absolute()
        .left_0()
        .right_0()
        .top(top + offset)
        .h(thickness)
        .bg(p.c.line)
}

fn underline_line(p: &Parts, hover: &Entity<bool>, cx: &App) -> AnyElement {
    let sizing = Sizing {
        height: Some(p.m.lh),
        pinned: true,
        ..Sizing::default()
    };
    let room = focus::room(Ds::get(cx));
    let anchor = p.anchor.clone();
    let hover = hover.clone();
    div()
        .id((p.spec.id.clone(), "underline"))
        .relative()
        .w_full()
        .h(p.m.lh)
        .debug_selector(move || anchor.to_string())
        .on_hover(move |on, _, cx| {
            hover.update(cx, |hovered, cx| {
                *hovered = *on;
                cx.notify();
            });
        })
        .children(tab_stop(p))
        .child(editor(p, &sizing, None, cx))
        .child(line_under(p, p.m.lh))
        .children(p.focused.then(|| focus::publish(p.handle.clone(), room)))
        .into_any_element()
}

/// The underline textarea: it grows a whole line at a time to `--textarea-max-lines`, then
/// scrolls under the edge fade. The field keeps its two line pixels out of the flow
/// (`margin-block-end: -2px`) so it sits on the text baseline like the input.
fn underline_area(p: &Parts, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let reserve = p.m.ring;
    let lines = ds.number(Number::TextareaMaxLines);
    let config = Config {
        id: (p.spec.id.clone(), "fade").into(),
        axis: Axis::Y,
        size: ds.len(Length::ScrollFadeSize),
        guard: ds.len(Length::SpaceXs),
    };
    let mut fade = scroll::fade(&config, Some(p.handle.clone()), true, window, cx);
    let sizing = Sizing {
        pad: [px(0.), px(0.), px(0.), reserve],
        min_height: Some(p.m.lh + reserve),
        max_height: Some(p.m.lh * lines + reserve),
        ..Sizing::default()
    };
    let room = focus::room(Ds::get(cx));
    let anchor = p.anchor.clone();
    let editor = editor(p, &sizing, Some(&fade.handle), cx);
    let seen = window.use_keyed_state((p.spec.id.clone(), "seen"), cx, |_, _| Default::default());
    let field = div()
        .relative()
        .w_full()
        .mb(-reserve)
        .debug_selector(move || anchor.to_string())
        .children(tab_stop(p))
        .child(editor)
        .child(reveal::follow_caret(
            p.state.clone(),
            fade.handle.clone(),
            seen,
            reserve,
        ))
        .children(fade.watch())
        .child(bottom_line(p));
    let field = fade.mask(field.into_any_element());
    // A column, so the field's negative end margin shortens the flow.
    div()
        .flex()
        .flex_col()
        .w_full()
        .child(field)
        .children(p.focused.then(|| focus::publish(p.handle.clone(), room)))
        .into_any_element()
}

/// The underline textarea's line, on the bottom edge of its box (inside the faded region).
fn bottom_line(p: &Parts) -> Div {
    let thickness = if p.focused { p.m.ring } else { p.m.border };
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .h(thickness)
        .bg(p.c.line)
}

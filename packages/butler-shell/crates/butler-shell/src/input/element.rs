//! The text element behind `TextInput`: wraps, scrolls past 8 lines, paints selection, the
//! IME marked-text underline and a blinking 1px caret, and registers the input handler.
use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, ElementInputHandler, Entity, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, PaintQuad, Pixels, SharedString, Style, TextAlign,
    TextRun, UnderlineStyle, Window, font, point, px, relative, size,
};

use super::{Layout, TextInput};
use crate::theme::FONT_BODY;

const FONT_SIZE: f32 = 14.;
const LINE: f32 = 20.;
const MAX_LINES: f32 = 8.;

pub(crate) struct TextElement {
    pub(crate) input: Entity<TextInput>,
}

impl IntoElement for TextElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

fn display_runs(input: &TextInput) -> (SharedString, Vec<TextRun>) {
    let (text, color) = if input.content.is_empty() {
        (input.placeholder.clone(), input.colors.placeholder)
    } else {
        (input.content.clone(), input.colors.text)
    };
    let run = TextRun {
        len: text.len(),
        font: font(FONT_BODY),
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
        letter_spacing: None,
    };
    let runs = match input
        .marked_range
        .as_ref()
        .filter(|_| !input.content.is_empty())
    {
        Some(m) => vec![
            TextRun {
                len: m.start,
                ..run.clone()
            },
            TextRun {
                len: m.end - m.start,
                underline: Some(UnderlineStyle {
                    color: Some(color),
                    thickness: px(1.),
                    wavy: false,
                }),
                ..run.clone()
            },
            TextRun {
                len: text.len() - m.end,
                ..run
            },
        ]
        .into_iter()
        .filter(|r| r.len > 0)
        .collect(),
        None => vec![run],
    };
    (text, runs)
}

fn shape(input: &TextInput, width: Option<Pixels>, window: &mut Window) -> Layout {
    let (text, runs) = display_runs(input);
    let text = window
        .text_system()
        .shape_text(text, px(FONT_SIZE), &runs, width, None)
        .ok();
    Layout {
        text,
        bounds: Bounds::default(),
        line_height: px(LINE),
    }
}

pub(crate) struct Prepaint {
    layout: Layout,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
    scroll: Pixels,
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let input = self.input.clone();
        let id = window.request_measured_layout(style, move |known, available, window, cx| {
            let width = known.width.or(match available.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let layout = shape(input.read(cx), width, window);
            let h = layout.height();
            size(
                width.unwrap_or(Pixels::ZERO),
                h.max(px(LINE)).min(px(LINE * MAX_LINES)),
            )
        });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let input = self.input.read(cx);
        let mut layout = shape(input, Some(bounds.size.width), window);
        layout.bounds = bounds;
        let lh = px(LINE);
        let content_h = layout.height();
        let caret = if input.content.is_empty() {
            Some(point(Pixels::ZERO, Pixels::ZERO))
        } else {
            layout.point_for(input.cursor_offset())
        };
        let mut scroll = input.scroll_top;
        if let Some(c) = caret {
            if c.y < scroll {
                scroll = c.y;
            }
            if c.y + lh > scroll + bounds.size.height {
                scroll = c.y + lh - bounds.size.height;
            }
        }
        scroll = scroll
            .max(Pixels::ZERO)
            .min((content_h - bounds.size.height).max(Pixels::ZERO));
        let origin = bounds.origin - point(Pixels::ZERO, scroll);
        let range = input.selected_range.clone();
        let mut selections = Vec::new();
        if !range.is_empty() && !input.content.is_empty() {
            selections = selection_quads(
                &layout,
                range.start,
                range.end,
                origin,
                bounds.size.width,
                input.colors.selection,
            );
        }
        let blink_on = (input.last_edit.elapsed().as_millis() / 530).is_multiple_of(2);
        let cursor = (range.is_empty() && blink_on)
            .then(|| {
                caret.map(|c| {
                    PaintQuad::new(Bounds::new(origin + c, size(px(1.), lh)))
                        .background(input.colors.text)
                })
            })
            .flatten();
        Prepaint {
            layout,
            cursor,
            selections,
            scroll,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        pre: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        let origin = bounds.origin - point(Pixels::ZERO, pre.scroll);
        let lh = px(LINE);
        window.with_content_mask(
            Some(gpui::ContentMask {
                bounds,
                ..Default::default()
            }),
            |window| {
                for q in pre.selections.drain(..) {
                    window.paint_quad(q);
                }
                if let Some(text) = &pre.layout.text {
                    let _ = text.paint(origin, lh, TextAlign::Left, None, window, cx);
                }
                if focus.is_focused(window)
                    && let Some(c) = pre.cursor.take()
                {
                    window.paint_quad(c);
                }
            },
        );
        let layout = std::mem::replace(
            &mut pre.layout,
            Layout {
                text: None,
                bounds,
                line_height: lh,
            },
        );
        let scroll = pre.scroll;
        self.input.update(cx, |input, _| {
            input.layout = Some(layout);
            input.scroll_top = scroll;
        });
    }
}

fn selection_quads(
    layout: &Layout,
    a: usize,
    b: usize,
    origin: gpui::Point<Pixels>,
    width: Pixels,
    color: gpui::Hsla,
) -> Vec<PaintQuad> {
    let lh = layout.line_height;
    let (Some(pa), Some(pb)) = (layout.point_for(a), layout.point_for(b)) else {
        return vec![];
    };
    let rect = |x0: Pixels, y: Pixels, x1: Pixels| {
        PaintQuad::new(Bounds::from_corners(
            origin + point(x0, y),
            origin + point(x1, y + lh),
        ))
        .background(color)
    };
    if pa.y == pb.y {
        return vec![rect(pa.x, pa.y, pb.x)];
    }
    let mut out = vec![rect(pa.x, pa.y, width)];
    let mut y = pa.y + lh;
    while y < pb.y {
        out.push(rect(Pixels::ZERO, y, width));
        y += lh;
    }
    out.push(rect(Pixels::ZERO, pb.y, pb.x));
    out
}

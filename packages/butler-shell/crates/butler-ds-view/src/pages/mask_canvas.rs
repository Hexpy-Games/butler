//! MaskCanvas.showcase.tsx: painting with the brush, the eraser and undo (the toolbar is the
//! product's, shown here for the flow), the painted region, the generating wash, the result
//! inside the region, and the compare picture.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::mask_canvas::{MaskCanvas, MaskCanvasState, MaskStroke, MaskTool};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::slider::Slider;
use gpui::{
    AnyElement, App, Entity, ImageSource, IntoElement as _, ParentElement as _, Styled as _,
    Window, div, px,
};

use super::media_frame::fixtures::{Kind, picture_of, svg};
use super::{Story, sub};
use crate::copy::Lang;

const WIDTH: u32 = 400;
const HEIGHT: u32 = 320;

struct Copy {
    picture: &'static str,
    brush: &'static str,
    eraser: &'static str,
    undo: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            picture: "Lake under hills",
            brush: "Brush",
            eraser: "Eraser",
            undo: "Undo",
        },
        Copy {
            picture: "언덕 아래 호수",
            brush: "브러시",
            eraser: "지우개",
            undo: "실행 취소",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Paint, erase, undo",
            render: painting,
        },
        Story {
            name: "Painted region",
            render: |lang, window, cx| frame(lang, "mc-region", Show::Region, window, cx),
        },
        Story {
            name: "Generating: the region shimmers",
            render: |lang, window, cx| frame(lang, "mc-generating", Show::Generating, window, cx),
        },
        Story {
            name: "Result fades in inside the region",
            render: |lang, window, cx| frame(lang, "mc-result", Show::Result, window, cx),
        },
        Story {
            name: "Compare: another picture, mask hidden",
            render: |lang, window, cx| frame(lang, "mc-compare", Show::Compare, window, cx),
        },
    ]
}

/// The edited picture: the same lake with a moon in place of the sun.
fn result_picture() -> ImageSource {
    svg(
        WIDTH,
        HEIGHT,
        "<rect width='400' height='320' fill='#29405a'/><circle cx='300' cy='96' r='30' fill='#eef1f5'/>\
<circle cx='314' cy='86' r='26' fill='#29405a'/>",
    )
}

/// A loose circle over the sun, as a user would paint it.
fn sun_strokes() -> Vec<MaskStroke> {
    let ring = (0..25)
        .map(|step| {
            let angle = step as f32 / 24. * std::f32::consts::TAU;
            (300. + angle.cos() * 30., 96. + angle.sin() * 30.)
        })
        .collect();
    vec![
        MaskStroke {
            tool: MaskTool::Brush,
            size: 40.,
            points: ring,
        },
        MaskStroke {
            tool: MaskTool::Brush,
            size: 44.,
            points: vec![(300., 96.)],
        },
    ]
}

fn mask_state(
    id: &'static str,
    strokes: Vec<MaskStroke>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<MaskCanvasState> {
    window.use_keyed_state(sub(id, "mask"), cx, move |_, _| {
        MaskCanvasState::new(WIDTH, HEIGHT, strokes)
    })
}

/// Paint with the brush, erase, undo.
fn painting(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = "mc-paint";
    let mask = mask_state(id, Vec::new(), window, cx);
    let tool = window.use_keyed_state(sub(id, "tool"), cx, |_, _| MaskTool::Brush);
    let size = window.use_keyed_state(sub(id, "size"), cx, |_, _| 32.0_f64);
    let (current, diameter) = (*tool.read(cx), *size.read(cx));
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the slider range is 8..=96"
    )]
    let brush_size = diameter as f32;
    let (brush, eraser) = (tool.clone(), tool.clone());
    let pick = |entity: Entity<MaskTool>, next: MaskTool| {
        move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
            entity.update(cx, |tool, cx| {
                *tool = next;
                cx.notify();
            });
        }
    };
    let undo = mask.clone();
    let mut undo_button = IconButton::new(sub(id, "undo"), c.undo)
        .glyph(Icon::Undo)
        .on_click(move |_, _, cx| {
            undo.update(
                cx,
                butler_ds::ui::blocks::mask_canvas::MaskCanvasState::undo,
            );
        });
    if mask.read(cx).strokes() == 0 {
        undo_button = undo_button.disabled();
    }
    let toolbar = Stack::row()
        .gap(Space::Xs)
        .child(
            IconButton::new(sub(id, "brush"), c.brush)
                .glyph(Icon::Brush)
                .pressed(current == MaskTool::Brush)
                .on_click(pick(brush, MaskTool::Brush)),
        )
        .child(
            IconButton::new(sub(id, "eraser"), c.eraser)
                .glyph(Icon::Eraser)
                .pressed(current == MaskTool::Eraser)
                .on_click(pick(eraser, MaskTool::Eraser)),
        )
        .child(undo_button);
    Stack::new()
        .gap(Space::Sm)
        .child(toolbar)
        .child(
            Slider::new(sub(id, "slider"), diameter, 8., 96.).on_value_change(
                move |next, _, cx| {
                    size.update(cx, |size, cx| {
                        *size = next;
                        cx.notify();
                    });
                },
            ),
        )
        .child(boxed(
            MaskCanvas::new(id, mask, picture_of(Kind::Place), c.picture)
                .tool(current)
                .brush_size(brush_size),
        ))
        .into_any_element()
}

#[derive(Clone, Copy)]
enum Show {
    Region,
    Generating,
    Result,
    Compare,
}

/// A mask with the sun painted, in one of its non-interactive states.
fn frame(
    lang: Lang,
    id: &'static str,
    show: Show,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let mask = mask_state(id, sun_strokes(), window, cx);
    let mut canvas = MaskCanvas::new(id, mask, picture_of(Kind::Place), c.picture);
    canvas = match show {
        Show::Region => canvas,
        Show::Generating => canvas.generating(true),
        Show::Result => canvas.result_src(Some(result_picture())),
        Show::Compare => canvas.compare_src(Some(result_picture())),
    };
    boxed(canvas).into_any_element()
}

/// The 280 px tall space the picture fits into.
fn boxed(canvas: MaskCanvas) -> gpui::Div {
    div().w_full().h(px(280.)).child(canvas)
}

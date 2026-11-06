//! DragPreview.showcase.tsx (with DragPreview.demo.tsx): picked elements, wide and tall crops,
//! the lifted tab, and the floating preview following the pointer over a stage. The crops are
//! drawn from the same rectangles and text as the React fixtures' SVGs
//! (`BrowserPane/fixtures/pages.ts`).
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::blocks::drag_preview::{DragPreview, DragPreviewImage, Floating};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Align, Columns, Cross, Grid, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div, point, px,
};

use super::{Story, probe};
use crate::copy::Lang;

/// One rectangle of a crop: x, y, width, height, radius, fill.
type Rect = (f32, f32, f32, f32, f32, u32);

/// A crop of `width` x `height` on `back`, its rectangles and texts drawn at `scale`.
fn crop(
    (width, height): (f32, f32),
    back: u32,
    rects: &'static [Rect],
    texts: Vec<(f32, f32, f32, f32, SharedString)>,
    scale: f32,
) -> AnyElement {
    let mut el = div()
        .relative()
        .w(px(width * scale))
        .h(px(height * scale))
        .bg(gpui::rgb(back));
    for &(x, y, w, h, r, fill) in rects {
        el = el.child(
            div()
                .absolute()
                .left(px(x * scale))
                .top(px(y * scale))
                .w(px(w * scale))
                .h(px(h * scale))
                .rounded(px(r * scale))
                .bg(gpui::rgb(fill)),
        );
    }
    for (x, y, size, weight, text) in texts {
        el = el.child(
            div()
                .absolute()
                .left(px(x * scale))
                .top(px((y - size * 0.8) * scale))
                .text_size(px(size * scale))
                .line_height(px(size * 1.2 * scale))
                .font_weight(gpui::FontWeight(weight))
                .text_color(gpui::rgb(0x0017_2033))
                .child(text),
        );
    }
    el.into_any_element()
}

/// `cropImage(variant)`: a picked chair card.
fn chair(variant: u8) -> DragPreviewImage {
    const RECTS: &[Rect] = &[
        (42., 22., 36., 52., 8., 0x0035_3a42),
        (57., 74., 6., 26., 0., 0x006b_7078),
        (0., 92., 120., 28., 0., 0x00ff_ffff),
        (8., 100., 60., 6., 3., 0x003a_3d42),
        (8., 110., 36., 6., 3., 0x0017_191c),
    ];
    let back = if variant == 0 {
        0x00df_e4ea
    } else {
        0x00ec_e8e1
    };
    DragPreviewImage::new(120., 120., move |scale| {
        crop((120., 120.), back, RECTS, Vec::new(), scale)
    })
}

/// `stripCrop(kind)`: a block element's whole box, its words at the start.
fn strip(kind: &'static str, lang: Lang) -> DragPreviewImage {
    let (title, sub) = lang.pick(
        ("Office chairs", "128 items \u{b7} lowest price"),
        ("사무용 의자", "128개 상품 \u{b7} 낮은 가격순"),
    );
    let filters = lang.pick(
        [
            "Price",
            "Under \u{20a9}100k",
            "\u{20a9}100\u{2013}200k",
            "Over \u{20a9}200k",
            "Features",
            "Mesh back",
            "Lumbar support",
            "Headrest",
        ],
        [
            "가격",
            "10만원 이하",
            "10-20만원",
            "20만원 이상",
            "기능",
            "메쉬 등받이",
            "요추 지지대",
            "헤드레스트",
        ],
    );
    match kind {
        "column" => DragPreviewImage::new(180., 260., move |scale| {
            let texts = filters
                .iter()
                .enumerate()
                .map(|(index, label)| {
                    #[expect(clippy::cast_precision_loss, reason = "eight labels")]
                    let y = 30. + index as f32 * 30.;
                    (12., y, 14., 400., SharedString::from(*label))
                })
                .collect();
            crop((180., 260.), 0x00ff_ffff, &[], texts, scale)
        }),
        "heading" => DragPreviewImage::new(640., 56., move |scale| {
            let texts = vec![(
                0.,
                (56. * 0.78_f32).round(),
                40.,
                800.,
                SharedString::from(title),
            )];
            crop((640., 56.), 0x00ff_ffff, &[], texts, scale)
        }),
        _ => DragPreviewImage::new(640., 24., move |scale| {
            let texts = vec![(
                0.,
                (24. * 0.78_f32).round(),
                18.,
                400.,
                SharedString::from(sub),
            )];
            crop((640., 24.), 0x00ff_ffff, &[], texts, scale)
        }),
    }
}

/// The site icon of the demo tab: a green rounded square with an S.
fn site_icon(cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .flex()
        .items_center()
        .justify_center()
        .size(ds.len(Length::IconSizeMd))
        .rounded(px(4.))
        .bg(gpui::rgb(0x001f_8f5f))
        .text_color(gpui::rgb(0x00fa_fafa))
        .text_size(px(9.))
        .font_weight(gpui::FontWeight(700.))
        .child("S")
        .into_any_element()
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Picked elements",
            render: picked,
        },
        Story {
            name: "Wide and tall crops sit whole",
            render: wide_and_tall,
        },
        Story {
            name: "Lifted tab",
            render: lifted_tab,
        },
        Story {
            name: "Floating: follows the pointer",
            render: floating,
        },
        Story {
            name: "Floating at mobile width",
            render: mobile,
        },
    ]
}

fn labeled(caption: &'static str, preview: impl gpui::IntoElement) -> AnyElement {
    Stack::new()
        .gap(Space::Md)
        .cross(Cross::Start)
        .child(preview)
        .child(Typo::caption(caption).tone(Tone::Tertiary))
        .into_any_element()
}

fn picked(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::row()
        .align(Align::Row)
        .gap(Space::Xxl)
        .wrap(true)
        .child(labeled("1", DragPreview::elements("dp-1", vec![chair(0)])))
        .child(labeled(
            "2",
            DragPreview::elements("dp-2", vec![chair(0), chair(1)]),
        ))
        .child(labeled(
            "12",
            DragPreview::elements("dp-12", vec![chair(0), chair(1)]).count(12),
        ))
        .child(labeled(
            "invalid",
            DragPreview::elements("dp-invalid", vec![chair(0), chair(1)]).invalid(true),
        ))
        .into_any_element()
}

fn wide_and_tall(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::row()
        .align(Align::Row)
        .gap(Space::Xxl)
        .wrap(true)
        .child(labeled(
            "heading",
            DragPreview::elements("dp-heading", vec![strip("heading", lang)]),
        ))
        .child(labeled(
            "line + column",
            DragPreview::elements("dp-line", vec![strip("line", lang), strip("column", lang)]),
        ))
        .into_any_element()
}

fn lifted_tab(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let title = lang.pick("Search results \u{2014} Shop", "검색 결과 \u{2014} 쇼핑");
    Stack::row()
        .align(Align::Row)
        .gap(Space::Xxl)
        .wrap(true)
        .child(DragPreview::tab("dp-tab", title).tab_icon(site_icon(cx)))
        .child(
            DragPreview::tab("dp-tab-invalid", title)
                .tab_icon(site_icon(cx))
                .invalid(true),
        )
        .into_any_element()
}

/// Keeps the stage's box in `area` (drawn against once more when it moves).
fn record_area(
    area: gpui::Entity<gpui::Bounds<gpui::Pixels>>,
) -> gpui::Canvas<gpui::Bounds<gpui::Pixels>> {
    gpui::canvas(
        |bounds, _, _| bounds,
        move |_, bounds, window, cx| {
            if *area.read(cx) != bounds {
                area.update(cx, |area, _| *area = bounds);
                window.request_animation_frame();
            }
        },
    )
    .absolute()
    .size_full()
}

/// A drag area whose right third refuses the drop: the floating preview follows the pointer in
/// stage pixels and flips to the no-entry badge over the refusing part.
fn stage(
    id: &'static str,
    (lang, tab): (Lang, bool),
    start: (f32, f32),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = gpui::ElementId::from(id);
    let at = window.use_keyed_state((key.clone(), "at"), cx, move |_, _| start);
    let area = window.use_keyed_state((key.clone(), "area"), cx, |_, _| {
        gpui::Bounds::<gpui::Pixels>::default()
    });
    let (pointer, stage_width) = (*at.read(cx), area.read(cx).size.width.as_f32());
    let invalid = stage_width > 0. && pointer.0 > stage_width * (2. / 3.);
    let (blocked, hint) = lang.pick(
        ("Can't drop here", "Move the pointer over the area"),
        (
            "여기에는 놓을 수 없어요",
            "영역 위로 포인터를 움직여 보세요",
        ),
    );
    let tab_title = lang.pick("Search results \u{2014} Shop", "검색 결과 \u{2014} 쇼핑");
    let preview = if tab {
        DragPreview::tab((key.clone(), "preview"), tab_title).tab_icon(site_icon(cx))
    } else {
        DragPreview::elements(
            (key.clone(), "preview"),
            vec![chair(0), strip("heading", lang)],
        )
        .count(3)
    }
    .invalid(invalid)
    .at(Floating::Absolute(point(px(pointer.0), px(pointer.1))));
    let ds = Ds::get(cx);
    let area = div()
        .id(id)
        .debug_selector(|| id.to_owned())
        .relative()
        .h(px(180.))
        .overflow_hidden()
        .rounded(ds.len(Length::RadiusControl))
        .border(ds.len(Length::BorderHairline))
        .border_dashed()
        .border_color(ds.color(Color::LineStrong))
        .on_mouse_move({
            let area = area.clone();
            move |event, _, cx| {
                let origin = area.read(cx).origin;
                let local = event.position - origin;
                at.update(cx, |at, cx| {
                    *at = (local.x.as_f32(), local.y.as_f32());
                    cx.notify();
                });
            }
        })
        .child(record_area(area))
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(gpui::relative(1. / 3.))
                .bg(ds.color(Color::Muted)),
        )
        .child(preview)
        .child(probe(format!("{id}-invalid-{invalid}")));
    Stack::new()
        .gap(Space::Xs)
        .child(area)
        .child(Typo::caption(if invalid { blocked } else { hint }).tone(Tone::Tertiary))
        .into_any_element()
}

fn floating(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let left = stage("dp-stage-elements", (lang, false), (56., 40.), window, cx);
    let right = stage("dp-stage-tab", (lang, true), (40., 64.), window, cx);
    Grid::new("dp-floating")
        .columns(Columns::fixed(2))
        .gap(Space::Md)
        .child(left)
        .child(right)
        .into_any_element()
}

fn mobile(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    stage("dp-stage-mobile", (lang, false), (56., 40.), window, cx)
}

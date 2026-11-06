//! MediaFrame.showcase.tsx (and MediaFrame.demo.tsx: the pictures that arrive late).
pub(super) mod fixtures;

use std::time::Duration;

use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Columns, Grid, Preset, Responsive, Space, Stack};
use butler_ds::ui::media_frame::{Aspect, Fit, MediaFrame};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, ImageSource, IntoElement as _, ParentElement as _, Window};

use self::fixtures::{Kind, broken, favicon, picture_of};
use super::Story;
use crate::copy::Lang;

struct Copy {
    paper: &'static str,
    place: &'static str,
    recipe: &'static str,
    product: &'static str,
    library: &'static str,
    fill: &'static str,
    strip: &'static str,
    column: &'static str,
    empty: &'static str,
    failed: &'static str,
    small: &'static str,
    large: &'static str,
    half: &'static str,
    cover: &'static str,
    contain: &'static str,
    failed_late: &'static str,
    replay: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            paper: "A paper's first page",
            place: "A lake trail",
            recipe: "A rice bowl",
            product: "A kettle",
            library: "A code library",
            fill: "Typical shape: spans the frame",
            strip: "Heading strip: inset on the matte",
            column: "Tall column: inset on the matte",
            empty: "No picture: the empty matte",
            failed: "Load error: the same matte",
            small: "Small picture (120 × 80): stays small",
            large: "Large picture (2× screenshot, 3000 × 2000 px): fits the column",
            half: "In a narrow column: capped at the column",
            cover: "Cover: fades in on load",
            contain: "Contain: fades in once its shape is known",
            failed_late: "Load error: the placeholder fades in",
            replay: "Replay",
        },
        Copy {
            paper: "논문 첫 페이지",
            place: "호숫가 산책로",
            recipe: "비빔밥 한 그릇",
            product: "전기 주전자",
            library: "코드 라이브러리",
            fill: "보통 모양: 틀을 채움",
            strip: "가로 띠: 매트 안쪽에",
            column: "세로 기둥: 매트 안쪽에",
            empty: "사진 없음: 빈 매트",
            failed: "불러오기 실패: 같은 매트",
            small: "작은 사진(120 × 80): 작은 그대로",
            large: "큰 사진(2배 스크린숏, 3000 × 2000 px): 칸에 맞게",
            half: "좁은 칸 안: 칸 폭까지",
            cover: "채움: 불러오면 서서히 나타남",
            contain: "맞춤: 모양을 알면 서서히 나타남",
            failed_late: "불러오기 실패: 자리표시가 서서히 나타남",
            replay: "다시 보기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Shapes: 1:1, 4:5, 3:4, 16:10, 16:9",
            render: shapes,
        },
        Story {
            name: "Fit: typical pictures span, extreme ones sit inset",
            render: fit,
        },
        Story {
            name: "Empty and failed: the matte keeps the shape",
            render: missing,
        },
        Story {
            name: "Natural size: small stays small, large fits",
            render: natural,
        },
        Story {
            name: "Image load: the picture fades in over the matte",
            render: |lang, window, cx| load_demo(lang, false, window, cx),
        },
        Story {
            name: "Reduced motion: the picture appears at once",
            render: |lang, window, cx| load_demo(lang, true, window, cx),
        },
    ]
}

fn columns(base: u8, compact: u8) -> Columns {
    Columns::Responsive(Responsive {
        compact: Some(compact),
        base: Preset::Fixed(base),
        wide: None,
    })
}

/// `Framed`: the frame and its caption.
fn framed(caption: String, frame: MediaFrame) -> AnyElement {
    Stack::new()
        .gap(Space::Xs)
        .child(frame)
        .child(Typo::caption(caption).tone(Tone::Secondary))
        .into_any_element()
}

fn shapes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let items = [
        ("1:1", Aspect::Square, Kind::Library, c.library),
        ("4:5", Aspect::FourFive, Kind::Product, c.product),
        ("3:4", Aspect::ThreeFour, Kind::Paper, c.paper),
        ("16:10", Aspect::SixteenTen, Kind::Place, c.place),
        ("16:9", Aspect::SixteenNine, Kind::Recipe, c.recipe),
    ];
    Grid::new("media-shapes")
        .columns(columns(3, 2))
        .gap(Space::Md)
        .children(items.map(|(shape, aspect, kind, name)| {
            let id = format!("media-shape-{shape}");
            let caption = format!("{shape} · {name}");
            framed(
                caption,
                MediaFrame::new(id).aspect(aspect).src(picture_of(kind)),
            )
        }))
        .into_any_element()
}

fn fit(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let items = [
        ("fill", Kind::Product, c.fill),
        ("strip", Kind::Strip, c.strip),
        ("column", Kind::Column, c.column),
    ];
    Grid::new("media-fit")
        .columns(columns(3, 1))
        .gap(Space::Md)
        .children(items.map(|(key, kind, caption)| {
            let id = format!("media-fit-{key}");
            framed(
                caption.to_owned(),
                MediaFrame::new(id).src(picture_of(kind)),
            )
        }))
        .into_any_element()
}

fn missing(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Grid::new("media-missing")
        .columns(columns(3, 2))
        .gap(Space::Md)
        .child(framed(
            c.empty.into(),
            MediaFrame::new("media-empty").aspect(Aspect::FourFive),
        ))
        .child(framed(
            c.failed.into(),
            MediaFrame::new("media-failed")
                .aspect(Aspect::FourFive)
                .src(broken()),
        ))
        .into_any_element()
}

/// Natural size: the frame takes the picture's own shape and never grows past its display width.
fn natural(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let small = |id: &'static str| {
        framed(
            c.small.into(),
            MediaFrame::new(id)
                .src(picture_of(Kind::Product))
                .natural(120., 80.),
        )
    };
    let large = |id: &'static str, caption: &'static str| {
        framed(
            caption.into(),
            MediaFrame::new(id)
                .src(picture_of(Kind::Place))
                .natural(1500., 1000.),
        )
    };
    Stack::new()
        .gap(Space::Lg)
        .child(small("media-natural-small"))
        .child(large("media-natural-large", c.large))
        .child(
            Grid::new("media-natural-pair")
                .columns(Columns::fixed(2))
                .gap(Space::Md)
                .child(large("media-natural-half", c.half))
                .child(small("media-natural-small-2")),
        )
        .into_any_element()
}

/// `useLateSrc`: `src` after `delay` ms of the round, none before.
pub(super) fn late(
    window: &mut Window,
    cx: &mut App,
    key: &str,
    delay: u64,
    src: impl FnOnce() -> ImageSource,
) -> Option<ImageSource> {
    let started = window.use_keyed_state(format!("{key}-start"), cx, |_, cx| {
        cx.background_executor().now()
    });
    let elapsed = cx
        .background_executor()
        .now()
        .saturating_duration_since(*started.read(cx));
    let wait = Duration::from_millis(delay);
    if elapsed < wait {
        window.request_animation_frame();
        return None;
    }
    Some(src())
}

/// Three pictures that arrive late: a cover crop, a contained picture and one that fails.
fn load_demo(lang: Lang, reduced: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let tag = if reduced { "still" } else { "fade" };
    let round_state = window.use_keyed_state(format!("media-round-{tag}"), cx, |_, _| 0usize);
    let round = *round_state.read(cx);
    let frames = [
        ("cover", c.cover, 500, Aspect::Square, true, Kind::Place),
        (
            "contain",
            c.contain,
            900,
            Aspect::FourFive,
            false,
            Kind::Product,
        ),
        (
            "failed",
            c.failed_late,
            1300,
            Aspect::Square,
            true,
            Kind::Place,
        ),
    ];
    let mut cells = Vec::new();
    for (key, caption, delay, aspect, placeholder, kind) in frames {
        let id = format!("media-load-{tag}-{key}-{round}");
        let src = late(window, cx, &id, delay, || {
            if key == "failed" {
                broken()
            } else {
                picture_of(kind)
            }
        });
        let late_arrived = src.is_some();
        let mut frame = MediaFrame::new(id.clone())
            .aspect(aspect)
            .reduced_motion(reduced);
        if key != "contain" {
            frame = frame.fit(Fit::Cover);
        }
        if placeholder && late_arrived {
            frame = frame.placeholder().placeholder_icon(favicon());
        }
        if let Some(src) = src {
            frame = frame.src(src);
        }
        cells.push(framed(caption.into(), frame));
    }
    Stack::new()
        .gap(Space::Md)
        .child(
            Grid::new(format!("media-load-grid-{tag}"))
                .columns(columns(3, 1))
                .gap(Space::Md)
                .children(cells),
        )
        .child(
            Stack::row().child(
                Button::new(format!("media-replay-{tag}"))
                    .variant(Variant::Secondary)
                    .size(Size::Sm)
                    .text(c.replay)
                    .on_click(move |_, _, cx| {
                        round_state.update(cx, |round, cx| {
                            *round += 1;
                            cx.notify();
                        });
                    }),
            ),
        )
        .into_any_element()
}

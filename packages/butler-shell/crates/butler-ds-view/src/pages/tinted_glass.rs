//! TintedGlass.showcase.tsx (+ its module CSS): glass over a stage of text and colour marks.
use butler_ds::tokens::{Color, GradientToken, Length};
use butler_ds::ui::context::Ds;
use butler_ds::ui::convert;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use butler_ds::ui::typo::{Role, Typo};
use gpui::{
    AnyElement, App, Bounds, Hsla, IntoElement as _, ParentElement as _, PathBuilder, Pixels,
    Styled as _, Window, canvas, div, point, px,
};

use super::Story;
use crate::copy::Lang;

/// `.mark` boxes of TintedGlass.showcase.module.css: edge offsets (top/right/bottom/left,
/// negative when unset), size and rotation, with the colour token and its share.
struct Mark {
    top: Option<f32>,
    right: Option<f32>,
    bottom: Option<f32>,
    left: Option<f32>,
    width: f32,
    height: f32,
    degrees: f32,
    color: Color,
    share: f32,
}

const MARKS: [Mark; 3] = [
    Mark {
        top: Some(28.),
        right: None,
        bottom: None,
        left: Some(24.),
        width: 120.,
        height: 82.,
        degrees: -9.,
        color: Color::Accent,
        share: 0.34,
    },
    Mark {
        top: None,
        right: Some(34.),
        bottom: Some(34.),
        left: None,
        width: 156.,
        height: 96.,
        degrees: 8.,
        color: Color::Ok,
        share: 0.26,
    },
    Mark {
        top: Some(42.),
        right: Some(88.),
        bottom: None,
        left: None,
        width: 64.,
        height: 150.,
        degrees: 18.,
        color: Color::Danger,
        share: 0.18,
    },
];

fn lines(lang: Lang) -> [&'static str; 6] {
    lang.pick(
        [
            "Messages keep scrolling behind the composer while you type.",
            "The glass keeps this text readable at the edges and quiet in the middle.",
            "Edge fades reveal the 4px blur; the center stays opaque.",
            "Popovers and menus use the same tinted surface at a smaller size.",
            "Colored marks show how the tint mixes with content behind it.",
            "Messages keep scrolling behind the composer while you type.",
        ],
        [
            "입력하는 동안에도 메시지는 입력창 뒤에서 계속 스크롤됩니다.",
            "유리 표면은 가장자리에서는 뒤 글자를 비추고 가운데에서는 조용히 가립니다.",
            "가장자리 페이드가 4px 블러를 드러내고 가운데는 불투명하게 유지됩니다.",
            "팝오버와 메뉴도 같은 색조 표면을 더 작은 크기로 씁니다.",
            "색 표시는 뒤 콘텐츠와 색조가 어떻게 섞이는지 보여 줍니다.",
            "입력하는 동안에도 메시지는 입력창 뒤에서 계속 스크롤됩니다.",
        ],
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Composer surface",
            render: composer,
        },
        Story {
            name: "Popover surface",
            render: popover,
        },
    ]
}

/// A rounded rectangle of `bounds`' size rotated about its centre.
fn paint_mark(bounds: Bounds<Pixels>, mark: &Mark, color: Hsla, window: &mut Window) {
    let (width, height) = (mark.width, mark.height);
    let left = mark
        .left
        .unwrap_or_else(|| f32::from(bounds.size.width) - mark.right.unwrap_or(0.) - width);
    let top = mark
        .top
        .unwrap_or_else(|| f32::from(bounds.size.height) - mark.bottom.unwrap_or(0.) - height);
    let center = point(
        bounds.origin.x + px(left + width / 2.),
        bounds.origin.y + px(top + height / 2.),
    );
    let r = 10f32.min(width / 2.).min(height / 2.); // --radius-panel
    let (hw, hh) = (width / 2., height / 2.);
    let mut path = PathBuilder::fill();
    let at = |dx: f32, dy: f32| point(px(dx), px(dy));
    path.move_to(at(-hw + r, -hh));
    path.line_to(at(hw - r, -hh));
    path.arc_to(point(px(r), px(r)), px(0.), false, true, at(hw, -hh + r));
    path.line_to(at(hw, hh - r));
    path.arc_to(point(px(r), px(r)), px(0.), false, true, at(hw - r, hh));
    path.line_to(at(-hw + r, hh));
    path.arc_to(point(px(r), px(r)), px(0.), false, true, at(-hw, hh - r));
    path.line_to(at(-hw, -hh + r));
    path.arc_to(point(px(r), px(r)), px(0.), false, true, at(-hw + r, -hh));
    path.close();
    path.rotate(mark.degrees);
    path.translate(center);
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// `.stage`: a bordered panel of readable text and marks, with `content` centred over it.
fn stage(lang: Lang, content: AnyElement, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let marks = MARKS
        .each_ref()
        .map(|mark| (mark, convert::with_alpha(ds.color(mark.color), mark.share)));
    let background = div()
        .absolute()
        .top(ds.len(Length::SpaceLg))
        .left(ds.len(Length::SpaceLg))
        .right(ds.len(Length::SpaceLg))
        .bottom(ds.len(Length::SpaceLg))
        .flex()
        .flex_col()
        .justify_center()
        .gap(ds.len(Length::SpaceXs))
        .overflow_hidden()
        .text_color(convert::with_alpha(ds.color(Color::TextPrimary), 0.6)) // DS: TintedGlass.showcase.module.css:34
        .text_size(ds.len(Length::FontSize3))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .children(lines(lang).map(|line| {
            butler_ds::ui::typo::Typo::text(line).wrap(butler_ds::ui::typo::Wrap::Anywhere)
        }));
    let picture = canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            for (mark, color) in &marks {
                paint_mark(bounds, mark, *color, window);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    div()
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .min_h(px(280.)) // DS: TintedGlass.showcase.module.css:4
        .overflow_hidden()
        .p(ds.len(Length::Space4))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPanel))
        .bg(convert::gradient(
            ds.tokens().gradient(GradientToken::ConversationBg),
        ))
        .child(background)
        .child(picture)
        .child(content)
        .into_any_element()
}

fn composer(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let title = lang.pick("Composer surface", "입력창 표면");
    let body = lang.pick(
        "Edge fades reveal the 4px blur while the center stays opaque like the composer surface.",
        "가장자리 페이드가 4px 블러를 드러내고, 가운데는 입력창처럼 불투명하게 유지됩니다.",
    );
    let glass = TintedGlass::new()
        .padding(GlassPadding::Lg)
        .radius(GlassRadius::Composer)
        .child(
            Stack::new()
                .gap(Space::Sm)
                .child(Typo::new(Role::PanelSectionTitle, title))
                .child(Typo::body(body)),
        );
    stage(
        lang,
        div()
            .w_full()
            .max_w(px(360.))
            .child(glass)
            .into_any_element(),
        cx,
    )
}

fn popover(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let glass = TintedGlass::new()
        .padding(GlassPadding::Sm)
        .radius(GlassRadius::Popover)
        .child(Typo::caption(
            lang.pick("Popover sized surface", "팝오버 크기 표면"),
        ));
    let stack = div()
        .w_full()
        .max_w(px(360.))
        .flex()
        .flex_col()
        .items_start()
        .child(div().w_full().max_w(px(240.)).child(glass));
    stage(lang, stack.into_any_element(), cx)
}

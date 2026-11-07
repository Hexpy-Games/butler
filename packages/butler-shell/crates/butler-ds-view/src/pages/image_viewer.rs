//! ImageViewer.showcase.tsx: the real modal (open it, page with the arrow keys, close with Esc or
//! a click on the scrim) and the surface inside a fixed frame: the first of three with caption
//! and source, the last without, and a picture that cannot load.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::image_viewer::{
    ImageViewer, ImageViewerSurface, ViewerImage, ViewerLabels, ViewerSource,
};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window};

use super::Story;
use super::done_icon_button::save;
use super::media_frame::fixtures::{Kind, broken, picture_of};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Open the viewer",
            render: live,
        },
        Story {
            name: "First of three: caption and source",
            render: first,
        },
        Story {
            name: "Last of three: no caption",
            render: last,
        },
        Story {
            name: "A picture that cannot load",
            render: failed,
        },
    ]
}

struct Copy {
    close: &'static str,
    previous: &'static str,
    next: &'static str,
    failed: &'static str,
    zoom_in: &'static str,
    zoom_out: &'static str,
    open: &'static str,
    save: &'static str,
    saved: &'static str,
    duplicate: &'static str,
    view: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            close: "Close",
            previous: "Previous image",
            next: "Next image",
            failed: "The image could not load",
            zoom_in: "Zoom in",
            zoom_out: "Zoom out",
            open: "Open the source page",
            save: "Save to library",
            saved: "Saved to library",
            duplicate: "Copy image",
            view: "View",
        },
        Copy {
            close: "닫기",
            previous: "이전 이미지",
            next: "다음 이미지",
            failed: "이미지를 불러오지 못했습니다",
            zoom_in: "확대",
            zoom_out: "축소",
            open: "원본 페이지 열기",
            save: "서랍에 저장",
            saved: "서랍에 저장했어요",
            duplicate: "이미지 복사",
            view: "보기",
        },
    )
}

fn labels(lang: Lang) -> ViewerLabels {
    let c = copy(lang);
    ViewerLabels {
        close: c.close.into(),
        previous: c.previous.into(),
        next: c.next.into(),
        failed: c.failed.into(),
        zoom_in: Some(c.zoom_in.into()),
        zoom_out: Some(c.zoom_out.into()),
    }
}

fn images(lang: Lang) -> Vec<ViewerImage> {
    let ko = lang == Lang::Ko;
    let source = |site: &'static str, en: &'static str, ko_text: &'static str| ViewerSource {
        site: site.into(),
        checked: Some(if ko { ko_text } else { en }.into()),
        icon: None,
    };
    vec![
        ViewerImage {
            src: picture_of(Kind::Product),
            alt: lang.pick("Gooseneck kettle", "구스넥 주전자").into(),
            caption: Some(
                lang.pick(
                    "Gooseneck pour-over kettle · matte black",
                    "구스넥 드립 주전자 · 매트 블랙",
                )
                .into(),
            ),
            source: Some(source(
                "shop.example.com",
                "Checked 5:41 PM",
                "오후 5:41 확인",
            )),
        },
        ViewerImage {
            src: picture_of(Kind::Place),
            alt: lang.pick("Lakeside trail", "호숫가 산책로").into(),
            caption: Some(
                lang.pick(
                    "Lakeside loop trail, east shore",
                    "호숫가 순환 산책로, 동쪽 기슭",
                )
                .into(),
            ),
            source: Some(source("trails.example.org", "Checked 10/12", "10/12 확인")),
        },
        ViewerImage {
            src: picture_of(Kind::Recipe),
            alt: lang.pick("Kimchi fried rice", "김치볶음밥").into(),
            caption: None,
            source: None,
        },
    ]
}

/// The IconButtons for the shown picture: open its page, save, copy.
fn actions(lang: Lang, cx: &App) -> Vec<AnyElement> {
    let c = copy(lang);
    let ds = Ds::get(cx);
    vec![
        IconButton::new("iv-open", c.open)
            .icon(icon(Icon::Popup, IconSize::Sm, ds))
            .into_any_element(),
        DoneIconButton::new("iv-save", c.save, c.saved)
            .icon(icon(Icon::Library, IconSize::Sm, ds))
            .on_action(save(false))
            .into_any_element(),
        IconButton::new("iv-copy", c.duplicate)
            .icon(icon(Icon::Copy, IconSize::Sm, ds))
            .into_any_element(),
    ]
}

fn live(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let shown = window.use_keyed_state("iv-index", cx, |_, _| None::<usize>);
    let (open, close, set) = (shown.clone(), shown.clone(), shown.clone());
    let mut viewer = ImageViewer::new("iv-modal", images(lang), *shown.read(cx), labels(lang))
        .on_index_change(move |index, _, cx| {
            set.update(cx, |shown, cx| {
                *shown = Some(index);
                cx.notify();
            });
        })
        .on_close(move |_, cx| {
            close.update(cx, |shown, cx| {
                *shown = None;
                cx.notify();
            });
        });
    for action in actions(lang, cx) {
        viewer = viewer.action(action);
    }
    gpui::div()
        .flex()
        .child(
            Button::new("iv-view")
                .variant(Variant::Outline)
                .text(copy(lang).view)
                .on_click(move |_, _, cx| {
                    open.update(cx, |shown, cx| {
                        *shown = Some(0);
                        cx.notify();
                    });
                }),
        )
        .child(viewer)
        .into_any_element()
}

fn contained(
    id: &'static str,
    lang: Lang,
    (image, index, total): (ViewerImage, usize, usize),
    cx: &App,
) -> AnyElement {
    let step = |on: bool| on.then(|| std::rc::Rc::new(|_: &mut Window, _: &mut App| {}) as _);
    ImageViewerSurface::new(id, image, (index, total), labels(lang))
        .contained()
        .actions(actions(lang, cx))
        .on_previous(step(index > 0))
        .on_next(step(index + 1 < total))
        .on_close(Some(std::rc::Rc::new(|_, _| {})))
        .into_any_element()
}

fn first(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let all = images(lang);
    contained("iv-first", lang, (all[0].clone(), 0, 3), cx)
}

fn last(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let all = images(lang);
    contained("iv-last", lang, (all[2].clone(), 2, 3), cx)
}

fn failed(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let image = ViewerImage {
        src: broken(),
        alt: "Broken".into(),
        caption: None,
        source: None,
    };
    contained("iv-failed", lang, (image, 0, 1), cx)
}

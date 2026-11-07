//! Wallpaper.showcase.tsx, the still-image subset: the module playground on the bundled posters,
//! the image wallpaper with its fit and dim, and the container scope. The WebGL engine stories
//! (drift, paper overlay, transparent decoration, generated param controls, motion) are P6.
use std::sync::Arc;

use butler_ds::tokens::Length;
use butler_ds::ui::blocks::wallpaper::{
    ImageCache, ImageFit, ImageLoader, ImageVariant, Wallpaper, WallpaperSource, WallpaperTone,
    builtin_poster,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div, px,
};

use super::{Story, probe};
use crate::copy::Lang;

/// The module names the playground lists, in registry order. // DS: modules/index.ts
const MODULES: [(&str, &str, &str); 11] = [
    ("butler.riso-print", "Riso Print", "리소 프린트"),
    ("butler.bloom", "Bloom", "Bloom"),
    ("butler.silk", "Silk", "Silk"),
    ("butler.riso-flow", "Riso Flow", "리소 플로우"),
    ("butler.lamina", "Lamina", "이끼 잎"),
    ("butler.diatom", "Diatom Areolae", "규조 격자"),
    ("butler.dusk", "Dusk Horizon", "해질녘 지평선"),
    ("butler.shoreline", "Shoreline", "해안선"),
    ("butler.photo-clouds", "Sunset Clouds", "노을 구름"),
    ("butler.photo-daisies", "Daisy Field", "데이지 들판"),
    ("butler.stipple", "Stipple", "점묘"),
];

struct Copy {
    wallpaper: &'static str,
    image: &'static str,
    none: &'static str,
    caption: &'static str,
    fit: &'static str,
    fill: &'static str,
    whole: &'static str,
    dim: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            wallpaper: "Wallpaper",
            image: "Image",
            none: "None",
            caption: "Fixed full-screen layer; this stage contains it.",
            fit: "Fit",
            fill: "Fill",
            whole: "Fit",
            dim: "Dim",
        },
        Copy {
            wallpaper: "월페이퍼",
            image: "이미지",
            none: "없음",
            caption: "화면 전체에 고정되는 층이며, 이 무대가 그 범위를 가둡니다.",
            fit: "맞춤",
            fill: "채우기",
            whole: "맞추기",
            dim: "어둡게",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Module playground",
            render: playground,
        },
        Story {
            name: "Image wallpaper",
            render: image_wallpaper,
        },
        Story {
            name: "Viewport scope",
            render: viewport_scope,
        },
    ]
}

/// `Wallpaper.showcase.module.css:2-8`: a 320px stage with panel corners that clips the layer.
fn stage(layer: impl gpui::IntoElement, height: f32, cx: &App) -> AnyElement {
    div()
        .relative()
        .h(px(height))
        .overflow_hidden()
        .rounded(Ds::get(cx).len(Length::RadiusPanel))
        .child(layer)
        .into_any_element()
}

fn chosen(
    id: &'static str,
    initial: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (SharedString, impl Fn(&str, &mut Window, &mut App) + 'static) {
    let state = window.use_keyed_state(id, cx, move |_, _| SharedString::from(initial));
    let value = state.read(cx).clone();
    (value, move |next: &str, _: &mut Window, cx: &mut App| {
        let next = SharedString::from(next.to_owned());
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
    })
}

fn playground(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (choice, change) = chosen("wallpaper-choice", "butler.riso-print", window, cx);
    let source = match choice.as_ref() {
        "none" => WallpaperSource::None,
        module => WallpaperSource::Live {
            module: module.to_owned().into(),
        },
    };
    let layer = if choice.as_ref() == "image" {
        image_layer(ImageFit::Cover, 0.1)
    } else {
        Wallpaper::new(source)
    };
    let mut select = NativeSelect::new("wallpaper-select")
        .probe("wallpaper-select")
        .size(SelectSize::Sm)
        .value(choice.clone());
    for (id, en, ko) in MODULES {
        select = select.option(id, lang.pick(en, ko));
    }
    let select = select
        .option("image", c.image)
        .option("none", c.none)
        .on_change(change);
    Stack::new()
        .gap(Space::Md)
        .child(stage(layer, 320., cx))
        .child(select)
        .child(probe(format!("wallpaper-{choice}")))
        .into_any_element()
}

/// Stands in for the app's loader: the showcase has no asset store, so the thumbnail and the
/// full image are one bundled still. // DS: Wallpaper.demo.tsx:44-51
fn showcase_loader() -> ImageLoader {
    Arc::new(|_, _: ImageVariant| {
        builtin_poster("butler.silk", WallpaperTone::Light)
            .ok_or_else(|| anyhow::anyhow!("Wallpaper showcase image is missing"))
    })
}

/// `imageSource` of Wallpaper.demo.tsx:118-121 without a filter.
fn image_layer(fit: ImageFit, dim: f32) -> Wallpaper {
    let asset: SharedString = "showcase-landscape".into();
    let source = WallpaperSource::Image {
        asset: asset.clone(),
        fit,
        dim,
        blur: 0.,
    };
    let wallpaper = Wallpaper::new(source);
    match ImageCache::new(showcase_loader()).image(&asset, ImageVariant::Full) {
        Ok(picture) => wallpaper.picture(picture),
        Err(_) => wallpaper,
    }
}

fn image_wallpaper(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (fit, change_fit) = chosen("wallpaper-fit", "cover", window, cx);
    let (dim, change_dim) = chosen("wallpaper-dim", "0.1", window, cx);
    let fit_choice = if fit.as_ref() == "contain" {
        ImageFit::Contain
    } else {
        ImageFit::Cover
    };
    let dim_value: f32 = dim.parse().unwrap_or(0.1);
    Stack::new()
        .gap(Space::Md)
        .child(stage(image_layer(fit_choice, dim_value), 320., cx))
        .child(
            SegmentedControl::new("wallpaper-fit", c.fit, fit)
                .size(Size::Sm)
                .options([
                    Choice::new("cover", c.fill),
                    Choice::new("contain", c.whole),
                ])
                .on_value_change(change_fit),
        )
        .child(
            SegmentedControl::new("wallpaper-dim", c.dim, dim)
                .size(Size::Sm)
                .options(["0", "0.1", "0.3", "0.5"].map(|value| Choice::new(value, value)))
                .on_value_change(change_dim),
        )
        .into_any_element()
}

fn viewport_scope(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let silk = WallpaperSource::Live {
        module: "butler.silk".into(),
    };
    // `Wallpaper.showcase.module.css:11-21`: a 220px stage that centres its caption over the layer.
    div()
        .id("wallpaper-viewport")
        .relative()
        .h(px(220.))
        .overflow_hidden()
        .rounded(Ds::get(cx).len(Length::RadiusPanel))
        .child(Wallpaper::new(silk))
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(Typo::caption(c.caption).tone(Tone::Secondary)),
        )
        .into_any_element()
}

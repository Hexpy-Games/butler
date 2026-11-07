//! Markdown images (`.markdown img`): the natural size, never upscaled, capped by the column and
//! by 60% of the window height (640px at most), an inset hairline outline, the panel radius.
use std::sync::Arc;

use gpui::{
    AnyElement, App, Image, ImageFormat, ImageSource, IntoElement as _, ObjectFit,
    ParentElement as _, Styled as _, StyledImage as _, div, img, px, relative,
};

use super::Env;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

/// The tallest an image gets.
const MAX_HEIGHT: f32 = 640.;
/// The share of the window height an image may take.
const MAX_SHARE: f32 = 0.6;

/// The picture `src` names: a URL or path, or a percent-encoded SVG data URI.
fn source(src: &str) -> ImageSource {
    if let Some(body) = src.strip_prefix("data:image/svg+xml,") {
        let bytes = percent_decode(body);
        return ImageSource::Image(Arc::new(Image::from_bytes(ImageFormat::Svg, bytes)));
    }
    ImageSource::from(src.to_owned())
}

fn percent_decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        let escape = (bytes[at] == b'%')
            .then(|| bytes.get(at + 1..at + 3))
            .flatten()
            .and_then(|pair| Some(hex(pair[0])? * 16 + hex(pair[1])?));
        match escape {
            Some(value) => {
                out.push(u8::try_from(value).unwrap_or(b'?'));
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    out
}

/// The `width` and `height` an SVG data URI declares: the natural size of the picture.
fn natural(src: &str) -> Option<(f32, f32)> {
    let body = percent_decode(src.strip_prefix("data:image/svg+xml,")?);
    let text = String::from_utf8(body).ok()?;
    let attr = |name: &str| {
        let at = text.find(&format!(" {name}="))? + name.len() + 2;
        let rest = &text[at + 1..];
        rest[..rest.find(['\'', '"'])?].parse::<f32>().ok()
    };
    Some((attr("width")?, attr("height")?))
}

/// An inline image: `inline-block`, so a badge stays in its sentence.
pub(super) fn inline(src: &str, _alt: &str, env: &Env, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let height = (env.viewport_height * MAX_SHARE).min(MAX_HEIGHT);
    let mut frame = div().relative().flex_none().self_center();
    let mut height = height;
    if let Some((width, tall)) = natural(src) {
        height = height.min(tall);
        frame = frame
            .w(relative(1.))
            .max_w(px(width))
            .aspect_ratio(width / tall);
    }
    frame
        .max_h(px(height))
        .rounded(ds.len(Length::RadiusPanel))
        .overflow_hidden()
        .bg(ds.color(Color::SurfaceRaised))
        .child(
            img(env
                .image
                .as_ref()
                .and_then(|resolve| resolve(src))
                .unwrap_or_else(|| source(src)))
            .object_fit(ObjectFit::Contain)
            .max_w(relative(1.))
            .max_h(px(height)),
        )
        .child(
            div()
                .absolute()
                .size_full()
                .top_0()
                .left_0()
                .rounded(ds.len(Length::RadiusPanel))
                .border(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::Line)),
        )
        .into_any_element()
}

//! MediaFrame/fixtures.ts: flat placeholder illustrations of unrelated subjects (no photos, no
//! brand marks), as SVG pictures. The library tile draws its braces as paths: gpui's SVG
//! renderer has no fonts for the `{ }` text of the React fixture.
use std::fmt::Write as _;
use std::sync::Arc;

use gpui::{Image, ImageFormat, ImageSource};

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Paper,
    Place,
    Recipe,
    Product,
    Library,
    Strip,
    Column,
}

fn svg(width: u32, height: u32, body: &str) -> ImageSource {
    let text = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='{height}' viewBox='0 0 {width} {height}'>{body}</svg>"
    );
    picture(ImageFormat::Svg, text.into_bytes())
}

fn picture(format: ImageFormat, bytes: Vec<u8>) -> ImageSource {
    ImageSource::Image(Arc::new(Image::from_bytes(format, bytes)))
}

/// A URL that never loads, for the failed state: bytes that are no picture.
pub(super) fn broken() -> ImageSource {
    picture(ImageFormat::Png, b"broken".to_vec())
}

/// A favicon for placeholder demos: a plain mark, no brand.
pub(super) fn favicon() -> ImageSource {
    svg(
        32,
        32,
        "<rect width='32' height='32' rx='7' fill='#3b6fd8'/><circle cx='16' cy='16' r='7' fill='#ffffff'/>",
    )
}

/// `n` bars of the given widths from `y0`, `step` apart.
fn bars(x: u32, y0: u32, step: u32, height: u32, widths: &[u32], fills: &[&str]) -> String {
    let mut out = String::new();
    for ((row, width), fill) in (0u32..).zip(widths).zip(fills.iter().cycle()) {
        let y = y0 + row * step;
        let radius = height / 2;
        let _ = write!(
            out,
            "<rect x='{x}' y='{y}' width='{width}' height='{height}' rx='{radius}' fill='{fill}'/>"
        );
    }
    out
}

/// Grey text lines of the given widths from `y0`, 12 apart.
fn text_lines(y0: u32, widths: &[u32]) -> String {
    let mut out = String::new();
    for (row, width) in (0u32..).zip(widths) {
        let y = y0 + row * 12;
        let _ = write!(
            out,
            "<rect x='60' y='{y}' width='{width}' height='5' rx='2.5' fill='#c9cdd2'/>"
        );
    }
    out
}

pub(super) fn picture_of(kind: Kind) -> ImageSource {
    match kind {
        Kind::Paper => svg(
            320,
            400,
            &format!(
                "<rect width='320' height='400' fill='#f3f1ec'/><rect x='36' y='28' width='248' height='344' fill='#ffffff'/>\
<rect x='60' y='56' width='200' height='12' rx='3' fill='#23262b'/><rect x='84' y='76' width='152' height='12' rx='3' fill='#23262b'/>\
<rect x='100' y='100' width='120' height='6' rx='3' fill='#9aa0a8'/>{}\
<rect x='60' y='196' width='200' height='96' rx='4' fill='#e7ecf3'/><path d='M72 276 L112 236 L148 256 L192 214 L248 244' fill='none' stroke='#3b6fd8' stroke-width='4'/>{}",
                text_lines(124, &[200, 200, 200, 200, 120]),
                text_lines(308, &[200, 200, 200])
            ),
        ),
        Kind::Place => svg(
            400,
            320,
            "<rect width='400' height='320' fill='#cfe3ef'/><circle cx='300' cy='96' r='34' fill='#f6d27a'/>\
<path d='M0 196 L92 120 L168 178 L248 108 L400 204 L400 320 L0 320 Z' fill='#6f8f74'/><path d='M0 222 L130 170 L250 214 L400 186 L400 320 L0 320 Z' fill='#4d6f58'/>\
<rect y='240' width='400' height='80' fill='#7fa9c4'/><rect x='60' y='262' width='120' height='4' rx='2' fill='#b9d3e3'/><rect x='220' y='286' width='96' height='4' rx='2' fill='#b9d3e3'/>",
        ),
        Kind::Recipe => svg(
            360,
            360,
            "<rect width='360' height='360' fill='#efe6da'/><circle cx='180' cy='184' r='132' fill='#d9cbb8'/><circle cx='180' cy='180' r='120' fill='#ffffff'/>\
<circle cx='180' cy='180' r='96' fill='#e9a25b'/><circle cx='150' cy='150' r='22' fill='#f7f1e3'/><circle cx='154' cy='146' r='10' fill='#f2b632'/>\
<circle cx='214' cy='204' r='12' fill='#5c9a4a'/><circle cx='196' cy='226' r='9' fill='#5c9a4a'/><circle cx='222' cy='160' r='8' fill='#c8432b'/><circle cx='140' cy='206' r='8' fill='#c8432b'/>",
        ),
        Kind::Product => svg(
            320,
            400,
            "<rect width='320' height='400' fill='#e9e7e3'/><ellipse cx='160' cy='330' rx='96' ry='8' fill='#000000' opacity='0.08'/>\
<path d='M92 170 Q92 140 120 136 L200 136 Q228 140 228 170 L236 316 Q236 326 226 326 L94 326 Q84 326 84 316 Z' fill='#3d4248'/>\
<path d='M228 190 Q284 190 280 246 Q278 286 236 300' fill='none' stroke='#3d4248' stroke-width='12'/><path d='M92 186 L40 150 L46 142 L100 172 Z' fill='#3d4248'/>\
<rect x='132' y='120' width='56' height='18' rx='6' fill='#25282c'/><rect x='104' y='176' width='18' height='120' rx='6' fill='#ffffff' opacity='0.12'/>",
        ),
        Kind::Library => svg(
            360,
            360,
            &format!(
                "<rect width='360' height='360' fill='#1f2633'/>\
<path d='M104 96 Q80 96 80 120 L80 150 Q80 172 56 176 Q80 180 80 202 L80 232 Q80 256 104 256' fill='none' stroke='#7aa2f7' stroke-width='12' stroke-linecap='round' transform='translate(0 -8)'/>\
<path d='M256 96 Q280 96 280 120 L280 150 Q280 172 304 176 Q280 180 280 202 L280 232 Q280 256 256 256' fill='none' stroke='#7aa2f7' stroke-width='12' stroke-linecap='round' transform='translate(0 -8)'/>{}",
                bars(
                    64,
                    244,
                    22,
                    10,
                    &[176, 128, 208],
                    &["#9ece6a", "#e0af68", "#565f89"]
                )
            ),
        ),
        Kind::Strip => svg(
            640,
            72,
            "<rect width='640' height='72' fill='#ffffff'/><rect x='0' y='22' width='360' height='28' rx='6' fill='#23262b'/>",
        ),
        Kind::Column => svg(
            160,
            420,
            &format!(
                "<rect width='160' height='420' fill='#ffffff'/>{}",
                bars(
                    16,
                    24,
                    48,
                    12,
                    &[112, 96, 120, 88, 104, 120, 72, 96],
                    &["#9aa0a8"]
                )
            ),
        ),
    }
}

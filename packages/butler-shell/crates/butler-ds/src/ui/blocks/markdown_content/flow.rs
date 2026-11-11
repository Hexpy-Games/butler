//! The flow of a paragraph with boxes in it: words, code chips, external references, images and
//! the task box wrap together on baselines. gpui has no inline element inside text, so the text
//! is cut into words (a space is a margin: a text item's width drops trailing whitespace).
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, font, px,
};

use super::inline::{self, Piece};
use super::{Env, Face};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::icon_px;
use crate::ui::inline_reference::InlineReference;
use crate::ui::markdown::{Inline, plain};
use crate::ui::motion::Props;

/// A task item's box: 13px, as the browser's disabled checkbox.
const BOX: f32 = 13.;

/// The advance of a space in `face`.
fn space(face: Face, ds: &Ds, window: &mut Window) -> gpui::Pixels {
    let system = window.text_system();
    let id = system.resolve_font(&font(ds.body_font().clone()));
    system
        .advance(id, face.size, ' ')
        .map_or(face.size * 0.25, |advance| advance.width)
}

/// The words of `text`, each with whether whitespace follows it.
fn words(text: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_whitespace() {
            gap = true;
            if let Some(last) = out.last_mut() {
                last.1 = true;
            }
        } else {
            if gap || out.is_empty() {
                out.push((String::new(), false));
                gap = false;
            }
            if let Some(last) = out.last_mut() {
                last.0.push(c);
            }
        }
    }
    out
}

pub(super) fn render(
    nodes: &[Inline],
    face: Face,
    task: Option<bool>,
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let gap = space(face, Ds::get(cx), window);
    let mut items: Vec<AnyElement> = Vec::new();
    if let Some(done) = task {
        items.push(task_box(done, gap, cx));
    }
    let mut at = 0;
    atoms(nodes, None, gap, env, key, &mut at, &mut items, window, cx);
    div()
        .flex()
        .flex_wrap()
        .items_baseline()
        .children(items)
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "one recursive walk over the nodes"
)]
fn atoms(
    nodes: &[Inline],
    link: Option<&str>,
    gap: gpui::Pixels,
    env: &Env,
    key: &str,
    at: &mut usize,
    out: &mut Vec<AnyElement>,
    window: &mut Window,
    cx: &mut App,
) {
    for node in nodes {
        *at += 1;
        let id = format!("{key}-{at}");
        match node {
            Inline::Text { .. } => {
                let mut parts = Vec::new();
                let ds = Ds::get(cx);
                inline::pieces(
                    std::slice::from_ref(node),
                    link,
                    env,
                    (ds.color(env.ink), ds.color(Color::AccentText)),
                    &mut parts,
                );
                for part in &parts {
                    out.extend(text_words(part, gap, &id, cx));
                }
            }
            Inline::Code(code) => out.push(chip(code, cx, window)),
            Inline::Break => out.push(div().w_full().h(px(0.)).into_any_element()),
            Inline::Image { src, alt } => {
                out.push(super::image::inline(src, alt, env, window, cx));
            }
            Inline::Link { href, children } if super::link::is_external(href) => {
                let label = plain(children);
                let mut reference = InlineReference::external(SharedString::from(id), href.clone());
                if !label.is_empty() {
                    reference = reference.label(label);
                }
                if let Some(source) = env.favicon.as_ref().and_then(|favicon| favicon(href)) {
                    reference = reference.favicon(source);
                }
                out.extend(reference.items(window, cx));
            }
            Inline::Link { href, children } => {
                atoms(children, Some(href), gap, env, &id, at, out, window, cx);
            }
        }
    }
}

fn text_words(part: &Piece, gap: gpui::Pixels, id: &str, cx: &App) -> Vec<AnyElement> {
    let ds = Ds::get(cx);
    let accent = ds.color(Color::AccentText);
    let mut items = Vec::new();
    if part.text.starts_with(' ') {
        items.push(div().w(gap).into_any_element());
    }
    for (index, (word, spaced)) in words(&part.text).into_iter().enumerate() {
        let mut el = div()
            .whitespace_nowrap()
            .mr(if spaced { gap } else { px(0.) });
        if let Some(weight) = part.style.font_weight {
            el = el.font_weight(weight);
        }
        if part.style.font_style == Some(gpui::FontStyle::Italic) {
            el = el.italic();
        }
        if part.style.strikethrough.is_some() {
            el = el.line_through();
        }
        let el = match &part.link {
            Some(href) => {
                let href = href.clone();
                div()
                    .id(SharedString::from(format!("{id}-{index}")))
                    .text_color(accent)
                    .underline()
                    .whitespace_nowrap()
                    .mr(if spaced { gap } else { px(0.) })
                    .on_click(move |_, _, cx| super::link::open(&href, cx))
                    .child(word)
                    .into_any_element()
            }
            None => el.child(word).into_any_element(),
        };
        let el = match part.fade {
            Some((value, timing)) => value
                .apply(
                    div().child(el),
                    &timing,
                    &Props {
                        opacity: Some((0., 1.)),
                        ..Default::default()
                    },
                )
                .into_any_element(),
            None => el,
        };
        items.push(el);
    }
    items
}

/// `code`: 0 4px padding, a hairline border, the control radius and the raised surface, set in
/// the code font. Only its width takes part in the line: the box is the font's content area,
/// not the line height.
fn chip(code: &str, cx: &App, window: &mut Window) -> AnyElement {
    let ds = Ds::get(cx);
    let code_font = ds.code_font().clone();
    let size = f32::from(ds.len(Length::TypoCodeSize));
    let line = f32::from(ds.len(Length::TypoCodeLineHeight));
    let system = window.text_system();
    let id = system.resolve_font(&code_font);
    let ascent = f32::from(system.ascent(id, px(size)));
    let descent = f32::from(system.descent(id, px(size)));
    let area = ascent + descent;
    let top = (line - area) / 2.;
    let border = f32::from(ds.len(Length::BorderHairline));
    let pad = f32::from(ds.len(Length::Space1));
    let mut text = div()
        .relative()
        .px(px(pad + border))
        .text_size(px(size))
        .line_height(px(line))
        .font_family(code_font.family.clone())
        .whitespace_nowrap()
        .child(
            div()
                .absolute()
                .top(px(top - border))
                .left_0()
                .right_0()
                .h(px(area + 2. * border))
                .border(px(border))
                .border_color(ds.color(Color::Line))
                .rounded(ds.len(Length::RadiusControl))
                .bg(ds.color(Color::SurfaceRaised)),
        )
        .child(div().relative().child(SharedString::from(code.to_owned())));
    text.text_style().font_fallbacks = code_font.fallbacks;
    text.into_any_element()
}

/// The disabled checkbox `remark-gfm` puts before a task item's text.
fn task_box(done: bool, gap: gpui::Pixels, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let ink = ds.color(if done {
        Color::Accent
    } else {
        Color::TextTertiary
    });
    let mut check = div()
        .flex()
        .items_center()
        .justify_center()
        .flex_none()
        .size(px(BOX))
        .mr(gap)
        .mt(px(3.))
        .rounded(px(2.))
        .border(px(1.))
        .border_color(ink)
        .text_color(convert::with_alpha(ink, 1.));
    if done {
        check = check
            .bg(ink)
            .text_color(ds.color(Color::NeutralWhite))
            .child(icon_px(Icon::CheckIcon, px(BOX - 3.)));
    }
    check.into_any_element()
}

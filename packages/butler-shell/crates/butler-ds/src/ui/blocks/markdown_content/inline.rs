//! A paragraph's inline content. Text with emphasis and plain links is one run of styled text (it
//! wraps like the browser and can be selected); a paragraph with a code chip, an external link,
//! an image or a task box is a flow of words and boxes, because gpui has no inline element
//! inside text.
use std::ops::Range;

use gpui::{
    AnyElement, App, FontStyle, FontWeight, HighlightStyle, Hsla, InteractiveText,
    IntoElement as _, SharedString, StrikethroughStyle, UnderlineStyle, Window, px,
};

use super::flow;
use super::{Env, Face};
use crate::tokens::Color;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::markdown::{Inline, Style};

/// A text run with its emphasis, after whitespace collapsing.
pub(super) struct Piece {
    pub(super) text: String,
    pub(super) style: Style,
    pub(super) link: Option<String>,
    pub(super) alpha: f32,
}

/// HTML collapses a run of whitespace (a soft break included) to one space.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = true;
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    out
}

/// The text pieces of `nodes`, cut at the streaming chunks.
pub(super) fn pieces(nodes: &[Inline], link: Option<&str>, env: &Env, out: &mut Vec<Piece>) {
    for node in nodes {
        match node {
            Inline::Text {
                text,
                style,
                source,
            } => {
                for (part, alpha) in cut(text, *source, env) {
                    out.push(Piece {
                        text: collapse(&part),
                        style: *style,
                        link: link.map(str::to_owned),
                        alpha,
                    });
                }
            }
            Inline::Link { href, children } => pieces(children, Some(href), env, out),
            Inline::Break => out.push(Piece {
                text: "\n".to_owned(),
                style: Style::default(),
                link: None,
                alpha: 1.,
            }),
            Inline::Code(_) | Inline::Image { .. } => {}
        }
    }
}

/// `text` cut where a streaming chunk starts, each part with its opacity. A run that no longer
/// maps onto the source (an escape or an entity) takes its covering chunk's fade whole.
fn cut(text: &str, source: Option<usize>, env: &Env) -> Vec<(String, f32)> {
    let Some(reveal) = &env.reveal else {
        return vec![(text.to_owned(), 1.)];
    };
    let Some(start) = source else {
        return vec![(text.to_owned(), reveal.alpha_at(usize::MAX))];
    };
    let mut parts = Vec::new();
    let mut from = 0;
    let mut cuts = reveal.cuts(start, start + text.len());
    cuts.push(start + text.len());
    for cut in cuts {
        let to = (cut - start).min(text.len());
        if to > from && text.is_char_boundary(to) {
            parts.push((text[from..to].to_owned(), reveal.alpha_at(start + from)));
            from = to;
        }
    }
    parts
}

/// Whether `nodes` hold something only a flow can draw.
fn needs_flow(nodes: &[Inline]) -> bool {
    nodes.iter().any(|node| match node {
        Inline::Code(_) | Inline::Image { .. } => true,
        Inline::Link { href, children } => super::link::is_external(href) || needs_flow(children),
        _ => false,
    })
}

/// A paragraph's content: the element, set in `face`.
pub(super) fn render(
    nodes: &[Inline],
    face: Face,
    task: Option<bool>,
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    if task.is_some() || needs_flow(nodes) {
        return flow::render(nodes, face, task, env, key, window, cx);
    }
    text(nodes, env, key, window, cx)
}

fn text(nodes: &[Inline], env: &Env, key: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    let mut parts = Vec::new();
    pieces(nodes, None, env, &mut parts);
    let ds = Ds::get(cx);
    let ink = ds.color(env.ink);
    let accent = ds.color(Color::AccentText);
    let mut content = String::new();
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let mut links: Vec<(Range<usize>, String)> = Vec::new();
    for part in &parts {
        let start = content.len();
        content.push_str(&part.text);
        let range = start..content.len();
        if range.is_empty() {
            continue;
        }
        let base: Hsla = if part.link.is_some() { accent } else { ink };
        let mut style = HighlightStyle {
            color: Some(convert::with_alpha(base, part.alpha)),
            ..HighlightStyle::default()
        };
        if part.style.bold {
            style.font_weight = Some(FontWeight::BOLD);
        }
        if part.style.italic {
            style.font_style = Some(FontStyle::Italic);
        }
        if part.style.strike {
            style.strikethrough = Some(StrikethroughStyle {
                thickness: px(1.),
                color: Some(base),
            });
        }
        if let Some(href) = &part.link {
            style.underline = Some(UnderlineStyle {
                thickness: px(1.),
                color: Some(accent),
                wavy: false,
            });
            links.push((range.clone(), href.clone()));
        }
        highlights.push((range, style));
    }
    let ranges: Vec<Range<usize>> = links.iter().map(|(range, _)| range.clone()).collect();
    let hrefs: Vec<String> = links.into_iter().map(|(_, href)| href).collect();
    let link_id = SharedString::from(format!("{key}-text"));
    crate::ui::selectable::selectable(
        SharedString::from(format!("{key}-select")),
        &SharedString::from(content),
        highlights,
        move |styled| {
            if ranges.is_empty() {
                return styled.into_any_element();
            }
            InteractiveText::new(link_id, styled)
                .on_click(ranges, move |index, _, cx| {
                    if let Some(href) = hrefs.get(index) {
                        super::link::open(href, cx);
                    }
                })
                .into_any_element()
        },
        window,
        cx,
    )
}

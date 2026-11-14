//! A paragraph's inline content. Text with emphasis and plain links is one run of styled text (it
//! wraps like the browser and can be selected); a paragraph with a code chip, an external link,
//! an image or a task box is a flow of words and boxes, because gpui has no inline element
//! inside text.
use std::ops::Range;

use gpui::{
    AnyElement, App, FontStyle, FontWeight, HighlightStyle, Hsla, InteractiveText,
    IntoElement as _, ParentElement as _, SharedString, StrikethroughStyle, Styled as _,
    StyledText, UnderlineStyle, Window, px,
};

use super::flow;
use super::{Env, Face};
use crate::tokens::Color;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::markdown::Inline;
use crate::ui::motion::{Props, Timing, Transition};

/// A text run with its emphasis, after whitespace collapsing.
pub(super) struct Piece {
    pub(super) text: String,
    pub(super) style: HighlightStyle,
    pub(super) link: Option<String>,
    pub(super) fade: Option<(Transition, Timing)>,
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
pub(super) fn pieces(
    nodes: &[Inline],
    link: Option<&str>,
    env: &Env,
    colors: (Hsla, Hsla),
    out: &mut Vec<Piece>,
) {
    for node in nodes {
        match node {
            Inline::Text {
                text,
                style,
                source,
            } => {
                let (ink, accent) = colors;
                let base = if link.is_some() { accent } else { ink };
                let mut face = HighlightStyle {
                    color: Some(base),
                    ..Default::default()
                };
                if style.bold {
                    face.font_weight = Some(FontWeight::BOLD);
                }
                if style.italic {
                    face.font_style = Some(FontStyle::Italic);
                }
                if style.strike {
                    face.strikethrough = Some(StrikethroughStyle {
                        thickness: px(1.),
                        color: Some(base),
                    });
                }
                if link.is_some() {
                    face.underline = Some(UnderlineStyle {
                        thickness: px(1.),
                        color: Some(accent),
                        wavy: false,
                    });
                }
                for (part, fade) in cut(text, *source, env) {
                    out.push(Piece {
                        text: collapse(&part),
                        style: face,
                        link: link.map(str::to_owned),
                        fade,
                    });
                }
            }
            Inline::Link { href, children } => pieces(children, Some(href), env, colors, out),
            Inline::Break => out.push(Piece {
                text: "\n".to_owned(),
                style: HighlightStyle::default(),
                link: None,
                fade: None,
            }),
            Inline::Code(_) | Inline::Image { .. } => {}
        }
    }
}

/// `text` cut where a streaming chunk starts, each part with its opacity. A run that no longer
/// maps onto the source (an escape or an entity) takes its covering chunk's fade whole.
fn cut(
    text: &str,
    source: Option<usize>,
    env: &Env,
) -> Vec<(String, Option<(Transition, Timing)>)> {
    let Some(reveal) = &env.reveal else {
        return vec![(text.to_owned(), None)];
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
    let text = text(nodes, env, cx);
    let ranges: Vec<Range<usize>> = text.links.iter().map(|(range, _)| range.clone()).collect();
    let hrefs: Vec<String> = text.links.into_iter().map(|(_, href)| href).collect();
    let link_id = SharedString::from(format!("{key}-text"));
    let base = crate::ui::selectable::selectable(
        SharedString::from(format!("{key}-select")),
        &text.content,
        text.highlights,
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
    );
    gpui::div()
        .relative()
        .min_w_0()
        .child(base)
        .children(text.layers)
        .into_any_element()
}

struct Text {
    content: SharedString,
    highlights: Vec<(Range<usize>, HighlightStyle)>,
    links: Vec<(Range<usize>, String)>,
    layers: Vec<gpui::Div>,
}

fn text(nodes: &[Inline], env: &Env, cx: &App) -> Text {
    let mut parts = Vec::new();
    let ds = Ds::get(cx);
    pieces(
        nodes,
        None,
        env,
        (ds.color(env.ink), ds.color(Color::AccentText)),
        &mut parts,
    );
    let mut content = String::new();
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let mut links: Vec<(Range<usize>, String)> = Vec::new();
    let mut fades = Vec::new();
    for part in &parts {
        let start = content.len();
        content.push_str(&part.text);
        let range = start..content.len();
        if range.is_empty() {
            continue;
        }
        if let Some(href) = &part.link {
            links.push((range.clone(), href.clone()));
        }
        if let Some(fade) = part.fade {
            fades.push((range.clone(), fade));
        }
        highlights.push((range, part.style));
    }
    let layers = fades
        .iter()
        .map(|(range, (value, timing))| {
            let highlights = highlights
                .iter()
                .map(|(piece, style)| {
                    let mut style = *style;
                    if piece != range {
                        style.color = style.color.map(|c| convert::with_alpha(c, 0.));
                        style.underline = None;
                        style.strikethrough = None;
                    }
                    (piece.clone(), style)
                })
                .collect::<Vec<_>>();
            value.apply(
                gpui::div()
                    // Inset 0: an absolute box in a block sits below the base text otherwise.
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .flex_col()
                    .child(StyledText::new(content.clone()).with_highlights(highlights)),
                timing,
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            )
        })
        .collect::<Vec<_>>();
    for (range, _) in &fades {
        for (piece, style) in &mut highlights {
            if piece == range {
                style.color = style.color.map(|c| convert::with_alpha(c, 0.));
                style.underline = None;
                style.strikethrough = None;
            }
        }
    }
    Text {
        content: content.into(),
        highlights,
        links,
        layers,
    }
}

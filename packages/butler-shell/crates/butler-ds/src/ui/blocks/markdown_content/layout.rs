//! The block rhythm of `.markdown` (`MarkdownContent.module.css`): the gaps between blocks, the
//! heading sizes, the list indents and markers, the quote rule. CSS margins collapse between
//! siblings (the larger wins), so a block's gap to its predecessor is computed from both.
use gpui::{
    AnyElement, App, FontWeight, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div, px,
};

use super::code::MarkdownCodeFrame;
use super::{Density, Env, Face, inline, table};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::copy_button::CopyButton;
use crate::ui::markdown::{Block, Item};

/// How a block takes part in the rhythm rules.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// `p, ul, ol, blockquote, table`: the targets of the `+` margin rules.
    Flow,
    Heading(u8),
    /// A fenced block's frame and the rule carry their own block margins.
    Frame,
    Rule,
}

fn kind(block: &Block) -> Kind {
    match block {
        Block::Heading { level, .. } => Kind::Heading(*level),
        Block::Code { .. } => Kind::Frame,
        Block::Rule => Kind::Rule,
        _ => Kind::Flow,
    }
}

/// Where in the tree a column of blocks sits.
#[derive(Clone, Copy)]
pub(super) struct Nest {
    /// A direct child of `.markdown`: the first-child and `>` rules apply.
    pub(super) top: bool,
    /// The content of a list item: a list in it follows its text by `--space-2`.
    pub(super) item: bool,
}

/// The lengths of a density.
struct Rhythm {
    block: f32,
    after_heading: f32,
    item: f32,
    indent: f32,
    frame: f32,
    rule: f32,
}

impl Rhythm {
    fn of(density: Density, ds: &Ds) -> Self {
        let space = |token| f32::from(ds.len(token));
        match density {
            Density::Document => Self {
                block: space(Length::Space4),
                after_heading: space(Length::Space3),
                item: space(Length::Space2),
                indent: space(Length::Space6),
                frame: space(Length::Space4),
                rule: space(Length::Space6),
            },
            Density::Compact => Self {
                block: space(Length::Space2),
                after_heading: space(Length::Space1),
                item: space(Length::Space1),
                indent: space(Length::Space5),
                frame: space(Length::Space2),
                rule: space(Length::Space4),
            },
        }
    }

    /// A heading's own `margin-top`.
    fn heading_top(level: u8, density: Density, ds: &Ds) -> f32 {
        let space = |token| f32::from(ds.len(token));
        match (density, level) {
            (Density::Compact, _) | (_, 4..) => space(Length::Space4),
            (_, 1) => 2. * space(Length::Space4),
            (_, 2) => space(Length::Space6),
            _ => space(Length::Space5),
        }
    }
}

/// A heading's face: size, line height and weight.
fn heading_face(level: u8, density: Density, ds: &Ds) -> (Face, f32) {
    let len = |size, line| Face {
        size: ds.len(size),
        line: ds.len(line),
    };
    let regular = ds.number(Number::FontWeightMedium);
    if density == Density::Compact {
        return (
            len(Length::FontSize3, Length::TypoBodyLineHeight),
            ds.number(Number::FontWeightSemibold),
        );
    }
    let face = match level {
        1 => len(Length::FontSize6, Length::TypoH2LineHeight),
        2 => len(Length::FontSize5, Length::TypoH4LineHeight),
        3 => len(Length::FontSize4, Length::TypoAppTitleLineHeight),
        _ => len(Length::FontSize3, Length::TypoBodyLineHeight),
    };
    (face, regular)
}

/// A column of blocks.
pub(super) fn blocks(
    list: &[Block],
    nest: Nest,
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut column = div().flex().flex_col().min_w_0();
    let mut previous: Option<(Kind, f32)> = None;
    for (index, block) in list.iter().enumerate() {
        let id = format!("{key}-{index}");
        let this = kind(block);
        let (rhythm, density) = (Rhythm::of(env.density, Ds::get(cx)), env.density);
        let top = match this {
            Kind::Heading(_) if nest.top && index == 0 => 0.,
            Kind::Heading(level) => Rhythm::heading_top(level, density, Ds::get(cx)),
            Kind::Frame => rhythm.frame,
            Kind::Rule => rhythm.rule,
            Kind::Flow => match previous {
                Some((Kind::Heading(_), _)) => rhythm.after_heading,
                Some((Kind::Flow | Kind::Frame | Kind::Rule, _)) if nest.top => rhythm.block,
                Some((Kind::Flow, _)) if nest.item && matches!(block, Block::List { .. }) => {
                    rhythm.item
                }
                _ => 0.,
            },
        };
        let gap = previous.map_or(top, |(_, bottom)| top.max(bottom));
        let bottom = match this {
            Kind::Frame => rhythm.frame,
            Kind::Rule => rhythm.rule,
            _ => 0.,
        };
        let element = one(block, env, &id, window, cx);
        column = column.child(div().mt(px(gap)).min_w_0().child(element));
        previous = Some((this, bottom));
    }
    // `.markdown` is a block formatting context: the last block's margin stays inside it.
    if let Some((_, bottom)) = previous.filter(|_| nest.top) {
        column = column.pb(px(bottom));
    }
    column.into_any_element()
}

fn body_face(env: &Env, ds: &Ds) -> Face {
    Face {
        size: ds.len(Length::FontSize3),
        line: match env.density {
            Density::Document => ds.len(Length::TypoBodyLineHeightDocument),
            Density::Compact => ds.len(Length::TypoBodyLineHeight),
        },
    }
}

fn one(block: &Block, env: &Env, key: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    match block {
        Block::Paragraph(nodes) => {
            let face = body_face(env, Ds::get(cx));
            inline::render(nodes, face, None, env, key, window, cx)
        }
        Block::Heading { level, content } => heading(*level, content, env, key, window, cx),
        Block::List { start, items } => list(*start, items, env, key, window, cx),
        Block::Quote(children) => quote(children, env, key, window, cx),
        Block::Code { language, text } => code(language.as_deref(), text, env, key),
        Block::Table(found) => {
            let face = body_face(env, Ds::get(cx));
            table::render(found, face, env, key, window, cx)
        }
        Block::Rule => {
            let ds = Ds::get(cx);
            div()
                .h(ds.len(Length::BorderHairline))
                .w_full()
                .bg(convert::with_alpha(ds.color(Color::Line), 0.34))
                .into_any_element()
        }
    }
}

fn heading(
    level: u8,
    content: &[crate::ui::markdown::Inline],
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (face, weight) = heading_face(level, env.density, Ds::get(cx));
    let ds = Ds::get(cx);
    let text = div()
        .text_size(face.size)
        .line_height(face.line)
        .font_weight(FontWeight(weight))
        .text_color(ds.color(Color::TextPrimary));
    let content = inline::render(
        content,
        face,
        None,
        &env.ink(Color::TextPrimary),
        key,
        window,
        cx,
    );
    crate::ui::context::keep_words(text.child(content)).into_any_element()
}

fn list(
    start: Option<u64>,
    items: &[Item],
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (rhythm, face) = {
        let ds = Ds::get(cx);
        (Rhythm::of(env.density, ds), body_face(env, ds))
    };
    let depth = env.depth;
    let nested = Env {
        depth: depth + 1,
        ..env.clone()
    };
    let mut column = div().flex().flex_col().min_w_0();
    for (index, item) in items.iter().enumerate() {
        let id = format!("{key}-{index}");
        let marker = super::marker::draw(
            start.map(|first| first + index as u64),
            depth,
            face,
            env,
            cx,
        );
        let content = item_content(item, &nested, face, &id, window, cx);
        let row = div()
            .relative()
            .min_w_0()
            .pl(px(rhythm.indent))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .w(px(rhythm.indent))
                    .child(marker),
            )
            .child(content);
        column = column.child(
            div()
                .mt(px(if index == 0 { 0. } else { rhythm.item }))
                .child(row),
        );
    }
    column.into_any_element()
}

/// A list item's blocks; a task item's box leads its first paragraph.
fn item_content(
    item: &Item,
    env: &Env,
    face: Face,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    use crate::ui::markdown::Block as B;
    let Some(done) = item.checked else {
        return blocks(
            &item.blocks,
            Nest {
                top: false,
                item: true,
            },
            env,
            key,
            window,
            cx,
        );
    };
    let mut rest = item.blocks.as_slice();
    let first = match rest.split_first() {
        Some((B::Paragraph(nodes), tail)) => {
            rest = tail;
            Some(inline::render(
                nodes,
                face,
                Some(done),
                env,
                key,
                window,
                cx,
            ))
        }
        _ => Some(inline::render(&[], face, Some(done), env, key, window, cx)),
    };
    let tail = blocks(
        rest,
        Nest {
            top: false,
            item: true,
        },
        env,
        key,
        window,
        cx,
    );
    let column = div().flex().flex_col().min_w_0().children(first);
    let ds = Ds::get(cx);
    let gap = if rest.is_empty() {
        0.
    } else {
        f32::from(ds.len(Length::Space2))
    };
    column
        .child(div().mt(px(gap)).child(tail))
        .into_any_element()
}

fn quote(
    children: &[Block],
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let inner = blocks(
        children,
        Nest {
            top: false,
            item: false,
        },
        &env.ink(Color::TextSecondary),
        key,
        window,
        cx,
    );
    let ds = Ds::get(cx);
    div()
        .min_w_0()
        .border_l(ds.len(Length::BorderWidthStrong))
        .border_color(ds.color(Color::LineStrong))
        .pl(ds.len(Length::Space4))
        .text_color(ds.color(Color::TextSecondary))
        .child(inner)
        .into_any_element()
}

fn code(language: Option<&str>, text: &str, env: &Env, key: &str) -> AnyElement {
    let mut frame = MarkdownCodeFrame::new(SharedString::from(key.to_owned()), text.to_owned())
        .language(language.unwrap_or_default().to_owned());
    if let Some((label, copied)) = env.copy.clone() {
        let body = text.to_owned();
        let copy =
            CopyButton::new(SharedString::from(format!("{key}-copy")), label, copied).text(body);
        frame = frame.actions(crate::ui::blocks::message_row::footer_actions(copy));
    }
    frame.into_any_element()
}

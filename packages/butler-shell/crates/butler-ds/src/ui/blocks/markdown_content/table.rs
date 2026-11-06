//! MarkdownTable (`MarkdownParts.tsx`, `.markdown table`): a collapsed-border table that is as
//! wide as its content up to the column, then shrinks its columns toward their longest words, and
//! scrolls sideways inside its own frame with edge fades. gpui has no table layout, so the
//! columns are sized the way CSS's automatic table layout does: from each cell's max-content and
//! min-content widths and the width the column offers (measured on the last frame).
use gpui::{
    AnyElement, App, ElementId, Font, FontWeight, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, TextRun, Window, div, font, px, relative,
};

use super::{Env, Face, inline};
use crate::tokens::{Color, Length, Number};
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::markdown::{Align, Inline, Table};
use crate::ui::scroll::engine::{self, Axis, Config};

/// A cell's content width: its longest line, and its longest unbreakable word.
struct Extent {
    max: f32,
    min: f32,
}

/// The advance of `text` in `face`.
fn advance(text: &str, family: &Font, size: f32, window: &mut Window) -> f32 {
    if text.is_empty() {
        return 0.;
    }
    let run = TextRun {
        len: text.len(),
        font: family.clone(),
        color: gpui::black(),
        background_color: None,
        letter_spacing: None,
        underline: None,
        strikethrough: None,
    };
    f32::from(
        window
            .text_system()
            .shape_line(SharedString::from(text.to_owned()), px(size), &[run])
            .width,
    )
}

/// The width the cell's text takes at max-content, and at min-content (its longest word).
fn extent(cell: &[Inline], face: Face, weight: f32, window: &mut Window, cx: &App) -> Extent {
    let ds = Ds::get(cx);
    let mut body = font(ds.body_font().clone());
    body.weight = FontWeight(weight);
    let mono = ds.code_font().clone();
    let (mono_size, chip) = (
        f32::from(ds.len(Length::TypoCodeSize)),
        2. * (f32::from(ds.len(Length::Space1)) + f32::from(ds.len(Length::BorderHairline))),
    );
    let size = f32::from(face.size);
    let (mut max, mut min) = (0f32, 0f32);
    let mut stack: Vec<&Inline> = cell.iter().rev().collect();
    while let Some(node) = stack.pop() {
        match node {
            Inline::Text { text, .. } => {
                max += advance(text, &body, size, window);
                for word in text.split_whitespace() {
                    min = min.max(advance(word, &body, size, window));
                }
            }
            Inline::Code(code) => {
                let width = advance(code, &mono, mono_size, window) + chip;
                max += width;
                min = min.max(width);
            }
            Inline::Link { href, children } if super::link::is_external(href) => {
                let label = super::link::label(&crate::ui::markdown::plain(children), href);
                // The favicon slot (1.125em) and its gap lead the label, which wraps anywhere.
                let lead = size * 1.125 + f32::from(ds.len(Length::Space1));
                // The flow sets each character as its own item.
                let chars: f32 = label
                    .chars()
                    .map(|c| advance(&c.to_string(), &body, size, window).ceil())
                    .sum();
                max += lead + chars;
                let first = label.chars().next().map(String::from).unwrap_or_default();
                min = min.max(lead + advance(&first, &body, size, window));
            }
            Inline::Link { children, .. } => stack.extend(children.iter().rev()),
            Inline::Image { .. } | Inline::Break => {}
        }
    }
    Extent {
        max: max.ceil(),
        min: min.ceil(),
    }
}

/// CSS automatic layout: the max-content widths if they fit, else the min-content widths plus a
/// share of the room that is the same fraction of the columns' flexible range.
fn widths(extents: &[Extent], room: f32) -> Vec<f32> {
    let max: f32 = extents.iter().map(|e| e.max).sum();
    let min: f32 = extents.iter().map(|e| e.min).sum();
    if room <= 0. || max <= room {
        return extents.iter().map(|e| e.max).collect();
    }
    if min >= room {
        return extents.iter().map(|e| e.min).collect();
    }
    let share = (room - min) / (max - min);
    extents
        .iter()
        .map(|e| e.min + (e.max - e.min) * share)
        .collect()
}

fn cell(
    nodes: &[Inline],
    (width, align, head): (f32, Align, bool),
    face: Face,
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let content = inline::render(nodes, face, None, env, key, window, cx);
    let ds = Ds::get(cx);
    let mut cell = div()
        .flex_none()
        .w(px(width))
        .px(ds.len(Length::Space3))
        .py(ds.len(Length::Space2))
        .border_r(ds.len(Length::BorderHairline))
        .border_b(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(content);
    cell = match align {
        Align::Start => cell,
        Align::Center => cell.text_center(),
        Align::End => cell.text_right(),
    };
    if head {
        cell = cell
            .bg(ds.color(Color::Selection))
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)));
    }
    cell.into_any_element()
}

/// Each column's content widths, with the cell padding and the shared border.
fn column_extents(table: &Table, face: Face, window: &mut Window, cx: &App) -> Vec<Extent> {
    let (pad, border, medium) = {
        let ds = Ds::get(cx);
        (
            2. * f32::from(ds.len(Length::Space3)),
            f32::from(ds.len(Length::BorderHairline)),
            ds.number(Number::FontWeightMedium),
        )
    };
    let columns = table
        .head
        .len()
        .max(table.rows.iter().map(Vec::len).max().unwrap_or(0));
    let mut extents: Vec<Extent> = (0..columns).map(|_| Extent { max: 0., min: 0. }).collect();
    let rows =
        std::iter::once((&table.head, true)).chain(table.rows.iter().map(|row| (row, false)));
    for (row, head) in rows {
        for (index, nodes) in row.iter().enumerate() {
            let weight = if head { medium } else { 400. };
            let found = extent(nodes, face, weight, window, cx);
            extents[index].max = extents[index].max.max(found.max);
            extents[index].min = extents[index].min.max(found.min);
        }
    }
    for extent in &mut extents {
        extent.max += pad + border;
        extent.min += pad + border;
    }
    extents
}

/// The table `table`, in the column it is laid out in.
pub(super) fn render(
    table: &Table,
    face: Face,
    env: &Env,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (seen, recorder) = measure::track(
        (ElementId::from(SharedString::from(key.to_owned())), "table"),
        window,
        cx,
    );
    let border = f32::from(Ds::get(cx).len(Length::BorderHairline));
    let extents = column_extents(table, face, window, cx);
    let room = f32::from(seen.width) - border;
    let sized = widths(&extents, room);
    let ds = Ds::get(cx);
    let (line, edge) = (ds.color(Color::Line), ds.len(Length::BorderHairline));
    let mut grid = div()
        .flex()
        .flex_col()
        .flex_none()
        .border_l(edge)
        .border_t(edge)
        .border_color(line);
    let all = std::iter::once((&table.head, true)).chain(table.rows.iter().map(|row| (row, false)));
    for (r, (row, head)) in all.enumerate() {
        let mut line = div().flex().flex_row();
        for (c, nodes) in row.iter().enumerate() {
            let align = table.aligns.get(c).copied().unwrap_or_default();
            let width = sized.get(c).copied().unwrap_or(0.);
            let id = format!("{key}-{r}-{c}");
            line = line.child(cell(
                nodes,
                (width, align, head),
                face,
                env,
                &id,
                window,
                cx,
            ));
        }
        grid = grid.child(line);
    }
    let config = Config {
        id: (
            ElementId::from(SharedString::from(key.to_owned())),
            "table-scroll",
        )
            .into(),
        axis: Axis::X,
        size: Ds::get(cx).len(Length::ScrollFadeSize),
        guard: Ds::get(cx).len(Length::SpaceXs),
    };
    let scroller = engine::scroller(
        &config,
        div().flex_none().min_w(relative(1.)).child(grid),
        window,
        cx,
    );
    div()
        .relative()
        .w_full()
        .min_w_0()
        .child(recorder)
        .child(scroller.element)
        .into_any_element()
}

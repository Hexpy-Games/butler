//! DS ChangedLineDiff (ChangedLineDiff.tsx / ChangedLineDiff.module.css): the changed lines of a
//! file: two line-number columns, a +/- marker and the code, added lines on the success tint and
//! deleted ones on the danger tint, scrolling sideways. The edge fades of the scroller are not
//! reproduced.
use gpui::{
    App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::strut;
use crate::ui::typo::{Role, Tone, Typo};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineType {
    Added,
    Deleted,
}

pub struct DiffLine {
    kind: LineType,
    old_line: Option<u32>,
    new_line: Option<u32>,
    content: SharedString,
}

impl DiffLine {
    pub fn new(kind: LineType, content: impl Into<SharedString>) -> Self {
        Self {
            kind,
            old_line: None,
            new_line: None,
            content: content.into(),
        }
    }

    pub fn old_line(mut self, line: u32) -> Self {
        self.old_line = Some(line);
        self
    }

    pub fn new_line(mut self, line: u32) -> Self {
        self.new_line = Some(line);
        self
    }
}

#[derive(IntoElement)]
pub struct ChangedLineDiff {
    id: ElementId,
    lines: Vec<DiffLine>,
}

impl ChangedLineDiff {
    pub fn new(id: impl Into<ElementId>, lines: Vec<DiffLine>) -> Self {
        Self {
            id: id.into(),
            lines,
        }
    }
}

/// The advance of one code character at the code role's size.
fn advance(window: &mut Window, ds: &Ds) -> f32 {
    let Some(tokens) = Role::Code.tokens() else {
        return 8.;
    };
    let size = ds.len(tokens.size);
    let font = ds.code_font().clone();
    let id = window.text_system().resolve_font(&font);
    window
        .text_system()
        .advance(id, size, '0')
        .map_or(f32::from(size) * 0.6, |advance| f32::from(advance.width))
}

/// The column widths: two number columns (`minmax(var(--space-xl), auto)` plus the cell
/// padding), the marker column, and the whole grid's width (the widest line).
fn column_widths(lines: &[DiffLine], char_width: f32, ds: &Ds) -> (f32, f32, f32, f32) {
    let sm = f32::from(ds.len(Length::SpaceSm));
    let digits = |pick: fn(&DiffLine) -> Option<u32>| {
        lines
            .iter()
            .filter_map(pick)
            .map(|line| line.to_string().len())
            .max()
            .unwrap_or(0)
    };
    let number = |chars: usize| {
        (chars as f32 * char_width + 2. * sm).max(f32::from(ds.len(Length::SpaceXl)))
    };
    let (old_w, new_w) = (
        number(digits(|l| l.old_line)),
        number(digits(|l| l.new_line)),
    );
    let marker_w = f32::from(ds.len(Length::SpaceMd));
    let widest = lines
        .iter()
        .map(|line| line.content.chars().count().max(1))
        .max()
        .unwrap_or(1);
    let content_w = widest as f32 * char_width + 2. * sm;
    (old_w, new_w, marker_w, old_w + new_w + marker_w + content_w)
}

impl RenderOnce for ChangedLineDiff {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let char_width = advance(window, ds);
        let (sm, xs) = (ds.len(Length::SpaceSm), ds.len(Length::SpaceXs));
        let (old_w, new_w, marker_w, total) = column_widths(&self.lines, char_width, ds);
        let cell = |text: Typo, width: f32, pad: gpui::Pixels| {
            div().flex_none().w(px(width)).px(pad).py(xs).child(text)
        };
        let rows = self.lines.into_iter().map(|line| {
            let (fill, ink, mark) = match line.kind {
                LineType::Added => (Color::ColorSuccessBg, Color::ColorSuccess, "+"),
                LineType::Deleted => (Color::ColorDangerBg, Color::ColorDanger, "−"),
            };
            let num = |value: Option<u32>| {
                Typo::new(Role::Code, value.map(|v| v.to_string()).unwrap_or_default())
                    .tone(Tone::Tertiary)
                    .align(crate::ui::typo::TextAlign::End)
            };
            let text = if line.content.is_empty() {
                " ".into()
            } else {
                line.content
            };
            div()
                .flex()
                .w_full()
                .bg(ds.color(fill))
                .text_color(ds.color(ink))
                .child(cell(num(line.old_line), old_w, sm))
                .child(cell(num(line.new_line), new_w, sm))
                .child(cell(
                    Typo::new(Role::Code, mark).tone(Tone::Inherit),
                    marker_w,
                    xs,
                ))
                .child(
                    div()
                        .flex_1()
                        .px(sm)
                        .py(xs)
                        .whitespace_nowrap()
                        .child(Typo::new(Role::Code, text).tone(Tone::Primary)),
                )
        });
        div()
            .id(self.id)
            .w_full()
            .overflow_x_scroll()
            .rounded(ds.len(Length::RadiusControl))
            .bg(ds.color(Color::Surface))
            .child(
                // `.lines` is a grid: its cells are blockified, with no strut around the code.
                strut::grid_scope(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_full()
                        .w(px(total))
                        .children(rows),
                ),
            )
    }
}

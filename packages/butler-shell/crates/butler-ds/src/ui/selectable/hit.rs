//! Hit testing in reading order and the word/paragraph selection boundaries.
use super::{Break, Pos, RunInfo, boundary};
use gpui::{Pixels, Point};
use std::ops::Range;

pub(super) fn position(runs: &[RunInfo], p: Point<Pixels>) -> Option<Pos> {
    let mut nearest = None;
    for (index, run) in runs.iter().enumerate() {
        let b = run.hitbox.bounds;
        if b.top() <= p.y && p.y < b.bottom() {
            let distance = (b.left() - p.x).max(p.x - b.right()).max(gpui::px(0.));
            if nearest.is_none_or(|(_, best)| distance < best) {
                nearest = Some((index, distance));
            }
        }
    }
    if let Some((run, _)) = nearest {
        let offset = runs[run].layout.index_for_position(p).unwrap_or_else(|i| i);
        return Some(Pos { run, offset });
    }
    if let Some(run) = runs.iter().position(|r| r.hitbox.top() > p.y) {
        return Some(Pos { run, offset: 0 });
    }
    runs.last().map(|r| Pos {
        run: runs.len() - 1,
        offset: r.text.len(),
    })
}

pub(super) fn word(text: &str, offset: usize) -> Range<usize> {
    let offset = boundary(text, offset);
    let at = if offset == text.len() {
        text.char_indices().next_back().map_or(0, |(i, _)| i)
    } else {
        offset
    };
    let class = |c: char| {
        if c.is_whitespace() {
            0
        } else if c.is_alphanumeric() || c == '_' {
            1
        } else {
            2
        }
    };
    let Some(c) = text[at..].chars().next() else {
        return 0..0;
    };
    let mut start = at;
    for (i, previous) in text[..at].char_indices().rev() {
        if class(previous) != class(c) {
            break;
        }
        start = i;
    }
    let mut end = at;
    for (i, next) in text[at..].char_indices() {
        if class(next) != class(c) {
            break;
        }
        end = at + i + next.len_utf8();
    }
    start..end
}

pub(super) fn paragraph(runs: &[RunInfo], pos: Pos) -> (Pos, Pos) {
    let text = &runs[pos.run].text;
    let offset = boundary(text, pos.offset);
    let start = match text[..offset].rfind('\n') {
        Some(i) => Pos {
            offset: i + 1,
            ..pos
        },
        None => Pos {
            run: (0..=pos.run)
                .rev()
                .find(|&i| runs[i].lead >= Break::Tab)
                .unwrap_or(0),
            offset: 0,
        },
    };
    let end = match text[offset..].find('\n') {
        Some(i) => Pos {
            offset: offset + i + 1,
            ..pos
        },
        None => match (pos.run + 1..runs.len()).find(|&i| runs[i].lead >= Break::Tab) {
            Some(run) => Pos { run, offset: 0 },
            None => Pos {
                run: runs.len() - 1,
                offset: runs.last().map_or(0, |r| r.text.len()),
            },
        },
    };
    (start, end)
}

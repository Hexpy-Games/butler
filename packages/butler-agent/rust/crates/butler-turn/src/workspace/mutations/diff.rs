use super::contracts::{ChangedFile, ChangedLine};

/// Builds the direct changed-file detail used by the native mutation boundary.
///
/// The source keeps a full LCS score matrix. We keep the same recurrence and
/// reconstruction order, but retain only two score rows and one decision bit
/// for each interior mismatch cell. Equal-line moves are recomputed from the
/// borrowed line slices during reconstruction.
/// Whether a changed file existed before the change or was created by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FileOrigin {
    Existing,
    Created,
}

pub(super) fn changed_file(
    path: &str,
    before: &[u8],
    after: &[u8],
    origin: FileOrigin,
) -> Option<ChangedFile> {
    let created = origin == FileOrigin::Created;
    let before_text = String::from_utf8_lossy(before).into_owned();
    let after_text = String::from_utf8_lossy(after).into_owned();
    let old_lines = split_lines(&before_text)?;
    let new_lines = split_lines(&after_text)?;

    let prefix = common_prefix(&old_lines, &new_lines);
    let suffix = common_suffix(&old_lines, &new_lines, prefix);
    let old_middle = old_lines.get(prefix..old_lines.len() - suffix)?;
    let new_middle = new_lines.get(prefix..new_lines.len() - suffix)?;
    let decisions = lcs_decisions(old_middle, new_middle)?;
    let diff = changed_lines(old_middle, new_middle, prefix, &decisions)?;
    if diff.lines.is_empty() && !created {
        return None;
    }
    Some(ChangedFile {
        path: path.to_owned(),
        additions: diff.additions,
        deletions: diff.deletions,
        lines: diff.lines,
        before_text,
        after_text,
        file_created: created,
    })
}

/// The LCS deletion decisions of the differing middle, computed bottom-up
/// with two score rows.
fn lcs_decisions(old: &[&str], new: &[&str]) -> Option<DecisionBits> {
    let mut decisions = DecisionBits::new(old.len(), new.len())?;
    let width = new.len().checked_add(1)?;
    let mut next = score_row(width)?;
    let mut current = score_row(width)?;
    for (old_index, old_line) in old.iter().enumerate().rev() {
        current.fill(0);
        for (new_index, new_line) in new.iter().enumerate().rev() {
            let down = *next.get(new_index)?;
            let score = if old_line == new_line {
                next.get(new_index + 1)?.checked_add(1)?
            } else {
                let right = *current.get(new_index + 1)?;
                // The source chooses deletion when the two scores tie.
                if down >= right {
                    decisions.mark_deletion(old_index, new_index);
                }
                down.max(right)
            };
            *current.get_mut(new_index)? = score;
        }
        std::mem::swap(&mut next, &mut current);
    }
    Some(decisions)
}

/// The changed lines of a diff and their counts.
struct Diff {
    lines: Vec<ChangedLine>,
    additions: usize,
    deletions: usize,
}

/// Walks the decisions from the top: equal lines advance both sides,
/// otherwise a deletion or addition is emitted with 1-based line numbers.
fn changed_lines(
    old: &[&str],
    new: &[&str],
    prefix: usize,
    decisions: &DecisionBits,
) -> Option<Diff> {
    let mut diff = Diff {
        lines: Vec::new(),
        additions: 0,
        deletions: 0,
    };
    diff.lines
        .try_reserve(old.len().checked_add(new.len())?)
        .ok()?;
    let (mut old_index, mut new_index) = (0, 0);
    loop {
        match (old.get(old_index), new.get(new_index)) {
            (None, None) => return Some(diff),
            (Some(old_line), Some(new_line)) if old_line == new_line => {
                old_index += 1;
                new_index += 1;
            }
            (Some(old_line), new_line)
                if new_line.is_none() || decisions.get(old_index, new_index) =>
            {
                diff.lines.push(ChangedLine {
                    kind: "deleted",
                    old_line: Some(prefix + old_index + 1),
                    new_line: None,
                    content: (*old_line).to_owned(),
                });
                diff.deletions += 1;
                old_index += 1;
            }
            (_, Some(new_line)) => {
                diff.lines.push(ChangedLine {
                    kind: "added",
                    old_line: None,
                    new_line: Some(prefix + new_index + 1),
                    content: (*new_line).to_owned(),
                });
                diff.additions += 1;
                new_index += 1;
            }
            (Some(_), None) => return None,
        }
    }
}

fn split_lines(value: &str) -> Option<Vec<&str>> {
    if value.is_empty() {
        return Some(Vec::new());
    }
    let capacity = value
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        .checked_add(1)?;
    let mut lines = Vec::new();
    lines.try_reserve_exact(capacity).ok()?;
    let mut parts = value.split('\n').peekable();
    while let Some(line) = parts.next() {
        let line = if parts.peek().is_some() {
            line.strip_suffix('\r').unwrap_or(line)
        } else {
            line
        };
        lines.push(line);
    }
    if lines.last() == Some(&"") {
        lines.pop();
    }
    Some(lines)
}

fn common_prefix(old: &[&str], new: &[&str]) -> usize {
    old.iter()
        .zip(new)
        .take_while(|(old, new)| old == new)
        .count()
}

fn common_suffix(old: &[&str], new: &[&str], prefix: usize) -> usize {
    let max = old.len().min(new.len()) - prefix;
    old.iter()
        .rev()
        .zip(new.iter().rev())
        .take(max)
        .take_while(|(old, new)| old == new)
        .count()
}

fn score_row(width: usize) -> Option<Vec<u32>> {
    let mut row = Vec::new();
    row.try_reserve_exact(width).ok()?;
    row.resize(width, 0);
    Some(row)
}

struct DecisionBits {
    bits: Vec<u8>,
    width: usize,
}

impl DecisionBits {
    fn new(old_len: usize, new_len: usize) -> Option<Self> {
        let cells = old_len.checked_mul(new_len)?;
        let bytes = cells.checked_add(7)?.checked_div(8)?;
        let mut bits = Vec::new();
        bits.try_reserve_exact(bytes).ok()?;
        bits.resize(bytes, 0);
        Some(Self {
            bits,
            width: new_len,
        })
    }

    fn mark_deletion(&mut self, old_index: usize, new_index: usize) {
        let bit = old_index * self.width + new_index;
        if let Some(byte) = self.bits.get_mut(bit / 8) {
            *byte |= 1 << (bit % 8);
        }
    }

    fn get(&self, old_index: usize, new_index: usize) -> bool {
        let bit = old_index * self.width + new_index;
        self.bits
            .get(bit / 8)
            .is_some_and(|byte| byte & (1 << (bit % 8)) != 0)
    }
}

#[cfg(test)]
mod tests;

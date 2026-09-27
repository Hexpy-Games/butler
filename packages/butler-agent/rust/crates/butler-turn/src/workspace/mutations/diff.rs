use super::contracts::{ChangedFile, ChangedLine};

/// Builds the direct changed-file detail used by the native mutation boundary.
///
/// The source keeps a full LCS score matrix. We keep the same recurrence and
/// reconstruction order, but retain only two score rows and one decision bit
/// for each interior mismatch cell. Equal-line moves are recomputed from the
/// borrowed line slices during reconstruction.
pub(super) fn changed_file(
    path: &str,
    before: &[u8],
    after: &[u8],
    created: bool,
) -> Option<ChangedFile> {
    let before_text = String::from_utf8_lossy(before).into_owned();
    let after_text = String::from_utf8_lossy(after).into_owned();
    let old_lines = split_lines(&before_text)?;
    let new_lines = split_lines(&after_text)?;

    let prefix = common_prefix(&old_lines, &new_lines);
    let suffix = common_suffix(&old_lines, &new_lines, prefix);
    let old_middle = old_lines.len() - prefix - suffix;
    let new_middle = new_lines.len() - prefix - suffix;
    let mut decisions = DecisionBits::new(old_middle, new_middle)?;
    let width = new_middle.checked_add(1)?;
    let mut next = score_row(width)?;
    let mut current = score_row(width)?;

    for old_index in (0..old_middle).rev() {
        current.fill(0);
        for new_index in (0..new_middle).rev() {
            if old_lines[prefix + old_index] == new_lines[prefix + new_index] {
                current[new_index] = next[new_index + 1].checked_add(1)?;
            } else {
                let down = next[new_index];
                let right = current[new_index + 1];
                current[new_index] = down.max(right);
                // The source chooses deletion when the two scores tie.
                decisions.set(old_index, new_index, down >= right);
            }
        }
        std::mem::swap(&mut next, &mut current);
    }

    let mut lines = Vec::new();
    lines
        .try_reserve(old_middle.checked_add(new_middle)?)
        .ok()?;
    let mut old_index = 0;
    let mut new_index = 0;
    let mut additions = 0;
    let mut deletions = 0;
    while old_index < old_middle || new_index < new_middle {
        if old_index < old_middle
            && new_index < new_middle
            && old_lines[prefix + old_index] == new_lines[prefix + new_index]
        {
            old_index += 1;
            new_index += 1;
            continue;
        }
        if old_index < old_middle
            && (new_index >= new_middle || decisions.get(old_index, new_index))
        {
            lines.push(ChangedLine {
                kind: "deleted",
                old_line: Some(prefix + old_index + 1),
                new_line: None,
                content: old_lines[prefix + old_index].to_owned(),
            });
            deletions += 1;
            old_index += 1;
        } else {
            lines.push(ChangedLine {
                kind: "added",
                old_line: None,
                new_line: Some(prefix + new_index + 1),
                content: new_lines[prefix + new_index].to_owned(),
            });
            additions += 1;
            new_index += 1;
        }
    }
    if lines.is_empty() && !created {
        return None;
    }
    Some(ChangedFile {
        path: path.to_owned(),
        additions,
        deletions,
        lines,
        before_text,
        after_text,
        file_created: created,
    })
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
    (0..max)
        .take_while(|offset| old[old.len() - offset - 1] == new[new.len() - offset - 1])
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

    fn set(&mut self, old_index: usize, new_index: usize, delete: bool) {
        if !delete {
            return;
        }
        let bit = old_index * self.width + new_index;
        self.bits[bit / 8] |= 1 << (bit % 8);
    }

    fn get(&self, old_index: usize, new_index: usize) -> bool {
        let bit = old_index * self.width + new_index;
        self.bits[bit / 8] & (1 << (bit % 8)) != 0
    }
}

#[cfg(test)]
mod tests;

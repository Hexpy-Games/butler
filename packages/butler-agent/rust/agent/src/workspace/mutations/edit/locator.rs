#[derive(Debug)]
pub(super) struct Location {
    pub offset: usize,
    pub start_line: usize,
}

#[derive(Debug)]
pub(super) struct LocateFailure {
    pub error: &'static str,
    pub occurrences: usize,
}

pub(super) fn locate(
    text: &str,
    old_text: &str,
    hint: Option<usize>,
) -> Result<Location, LocateFailure> {
    if old_text.is_empty() {
        return Err(LocateFailure {
            error: "old_text_mismatch",
            occurrences: 0,
        });
    }
    let mut search_from = 0;
    let mut scanned_to = 0;
    let mut line = 1;
    let mut first = None;
    let mut hinted = None;
    let mut hinted_count = 0;
    let mut count = 0;
    while search_from <= text.len().saturating_sub(old_text.len()) {
        let Some(found) = text[search_from..].find(old_text) else {
            break;
        };
        let offset = search_from + found;
        line += text.as_bytes()[scanned_to..offset]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();
        scanned_to = offset;
        let location = Location {
            offset,
            start_line: line,
        };
        if first.is_none() {
            first = Some(location);
        }
        count = (count + 1).min(2);
        if hint.is_none() && count == 2 {
            return Err(LocateFailure {
                error: "old_text_ambiguous",
                occurrences: 2,
            });
        }
        if hint == Some(line) {
            hinted_count = (hinted_count + 1).min(2);
            if hinted.is_none() {
                hinted = Some(Location {
                    offset,
                    start_line: line,
                });
            }
        }
        search_from = next_boundary(text, offset);
    }
    let Some(first) = first else {
        return Err(LocateFailure {
            error: "old_text_mismatch",
            occurrences: 0,
        });
    };
    if count == 1 {
        return Ok(first);
    }
    if hinted_count == 1 {
        return Ok(hinted.expect("one hinted match"));
    }
    Err(LocateFailure {
        error: "old_text_ambiguous",
        occurrences: count,
    })
}

fn next_boundary(text: &str, offset: usize) -> usize {
    let mut next = offset + 1;
    while next < text.len() && !text.is_char_boundary(next) {
        next += 1;
    }
    next
}

#[cfg(test)]
mod tests {
    use super::locate;

    #[test]
    fn overlapping_matches_and_single_stale_hint() {
        assert_eq!(locate("aaa", "aa", None).unwrap_err().occurrences, 2);
        assert_eq!(locate("one\ntwo", "two", Some(900)).unwrap().start_line, 2);
        assert_eq!(locate("😀😀", "😀", None).unwrap_err().occurrences, 2);
    }
}

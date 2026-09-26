use sha2::{Digest, Sha256};

use super::{ChangedFile, ChangedLine, changed_file};

fn detail(before: &[u8], after: &[u8], created: bool) -> ChangedFile {
    changed_file("synthetic.txt", before, after, created).expect("changed detail")
}

fn line(
    kind: &'static str,
    old_line: Option<usize>,
    new_line: Option<usize>,
    content: &str,
) -> ChangedLine {
    ChangedLine {
        kind,
        old_line,
        new_line,
        content: content.into(),
    }
}

fn assert_lines(actual: &[ChangedLine], expected: &[ChangedLine]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(actual.kind, expected.kind);
        assert_eq!(actual.old_line, expected.old_line);
        assert_eq!(actual.new_line, expected.new_line);
        assert_eq!(actual.content, expected.content);
    }
}

#[test]
fn preserves_source_text_and_line_projection() {
    let value = detail(
        b"same\r\nold\r\nkeep\r\n",
        b"same\r\nnew\r\nkeep\r\n",
        false,
    );
    assert_eq!(value.before_text, "same\r\nold\r\nkeep\r\n");
    assert_eq!(value.after_text, "same\r\nnew\r\nkeep\r\n");
    assert_eq!(value.additions, 1);
    assert_eq!(value.deletions, 1);
    assert_lines(
        &value.lines,
        &[
            line("deleted", Some(2), None, "old"),
            line("added", None, Some(2), "new"),
        ],
    );
}

#[test]
fn follows_deletion_tie_for_repeated_lines() {
    let value = detail(b"a\nb", b"b\na", false);
    assert_lines(
        &value.lines,
        &[
            line("deleted", Some(1), None, "a"),
            line("added", None, Some(2), "a"),
        ],
    );
}

#[test]
fn keeps_lone_cr_and_replaces_invalid_utf8_like_buffer_to_string() {
    let value = detail("a\rb".as_bytes(), "a\rc".as_bytes(), false);
    assert_lines(
        &value.lines,
        &[
            line("deleted", Some(1), None, "a\rb"),
            line("added", None, Some(1), "a\rc"),
        ],
    );
    let lone_cr = detail(b"a\r", b"b\r", false);
    assert_lines(
        &lone_cr.lines,
        &[
            line("deleted", Some(1), None, "a\r"),
            line("added", None, Some(1), "b\r"),
        ],
    );
    assert!(changed_file("synthetic.txt", &[0xff, b'a'], &[0xfe, b'a'], false).is_none());
    let replacement = detail(&[0xe1, 0x80, b'A'], &[0xe1, 0x80, b'B'], false);
    assert_eq!(replacement.before_text, "�A");
    assert_eq!(replacement.after_text, "�B");
}

#[test]
fn distinguishes_created_empty_file_and_unchanged_existing_file() {
    assert!(changed_file("synthetic.txt", b"same\n", b"same\n", false).is_none());
    let value = detail(b"", b"", true);
    assert_eq!(value.additions, 0);
    assert_eq!(value.deletions, 0);
    assert!(value.file_created);
    assert!(value.lines.is_empty());
}

#[test]
fn handles_large_disjoint_middle_without_truncation() {
    let before = (0..256)
        .map(|index| format!("old-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let after = (0..256)
        .map(|index| format!("new-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let value = detail(before.as_bytes(), after.as_bytes(), false);
    assert_eq!(value.deletions, 256);
    assert_eq!(value.additions, 256);
    assert_eq!(value.lines.len(), 512);
    assert_eq!(value.lines[0].kind, "deleted");
    assert_eq!(value.lines[0].old_line, Some(1));
    assert_eq!(value.lines[256].kind, "added");
    assert_eq!(value.lines[256].new_line, Some(1));
}

#[test]
fn source_repeated_line_oracle_matches_exhaustive_digest() {
    let values = source_values();
    let mut hash = Sha256::new();
    let mut checked = 0;
    for before in &values {
        for after in &values {
            let detail = changed_file("synthetic.txt", before.as_bytes(), after.as_bytes(), false);
            update_digest(&mut hash, before, after, detail.as_ref());
            checked += 1;
        }
    }
    assert_eq!(checked, 17_956);
    assert_eq!(
        format!("{:x}", hash.finalize()),
        "58be158be29d8709cc39b3481092f45c82e8c2353ecf504729da58b604d93bb8"
    );
}

#[test]
fn source_buffer_utf8_replacement_oracle_matches_bun() {
    let cases: &[(&[u8], &[u8])] = &[
        (&[0xff], &[0xfe]),
        (&[0xe1, 0x80, 0x41], &[0xe1, 0x80, 0x42]),
        (&[0xf0, 0x80, 0x80], &[0xf0, 0x80, 0x81]),
        (&[0xed, 0xa0, 0x80], &[0xed, 0xa0, 0x81]),
        (&[0x61, 0xc2, 0xa2], &[0x61, 0xc2, 0xa3]),
    ];
    let mut hash = Sha256::new();
    for (before, after) in cases {
        let detail = changed_file("utf8.bin", before, after, false);
        let (before_text, after_text, lines) = match detail.as_ref() {
            None => ("null".into(), "null".into(), "null".into()),
            Some(detail) => (
                serde_json::to_string(&detail.before_text).unwrap(),
                serde_json::to_string(&detail.after_text).unwrap(),
                lines_json(detail),
            ),
        };
        hash.update(format!(
            "{{\"before_text\":{before_text},\"after_text\":{after_text},\"lines\":{lines}}}\n"
        ));
    }
    assert_eq!(
        format!("{:x}", hash.finalize()),
        "996efb8c5317ceeca804b8a01efe04d82bb4b4d9560cb0b8b296a1b6551fa3dc"
    );
}

fn source_values() -> Vec<String> {
    let mut values = vec![String::new()];
    for length in 1..=6 {
        for pattern in 0..(1usize << length) {
            values.push(
                (0..length)
                    .map(|index| {
                        if pattern & (1 << index) != 0 {
                            "a"
                        } else {
                            "b"
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
    }
    values.extend([
        "\u{feff}a\r\nb\n".into(),
        "한글\n😀\n".into(),
        "a\rb".into(),
        "a\r".into(),
        "a\n".into(),
        "\n".into(),
        "x\nx\nx\n".into(),
    ]);
    values
}

fn update_digest(hash: &mut Sha256, before: &str, after: &str, detail: Option<&ChangedFile>) {
    hash.update(serde_json::to_string(before).unwrap());
    hash.update(b"\t");
    hash.update(serde_json::to_string(after).unwrap());
    hash.update(b"\t");
    match detail {
        None => hash.update(b"null"),
        Some(detail) => hash.update(lines_json(detail)),
    }
    hash.update(b"\n");
}

fn lines_json(detail: &ChangedFile) -> String {
    let mut value = String::from("[");
    for (index, line) in detail.lines.iter().enumerate() {
        if index != 0 {
            value.push(',');
        }
        value.push_str(&line_json(line));
    }
    value.push(']');
    value
}

fn line_json(line: &ChangedLine) -> String {
    let content = serde_json::to_string(&line.content).unwrap();
    match line.kind {
        "deleted" => format!(
            "{{\"type\":\"deleted\",\"old_line\":{},\"content\":{content}}}",
            line.old_line.unwrap(),
        ),
        "added" => format!(
            "{{\"type\":\"added\",\"new_line\":{},\"content\":{content}}}",
            line.new_line.unwrap(),
        ),
        kind => panic!("unexpected changed line kind {kind}"),
    }
}

use sha2::{Digest, Sha256};

use super::{ChangedFile, ChangedLine, FileOrigin, changed_file};

fn detail(before: &[u8], after: &[u8], created: bool) -> ChangedFile {
    let origin = if created {
        FileOrigin::Created
    } else {
        FileOrigin::Existing
    };
    changed_file("synthetic.txt", before, after, origin).expect("changed detail")
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

/// Pure-logic table: line diffs keep the source text and CRLF projection,
/// follow the deletion tie for repeated lines, keep lone CRs, replace invalid
/// UTF-8 like `Buffer.toString`, tell a created empty file from an unchanged
/// one, never truncate a large disjoint middle, and match the source oracle's
/// digest over every small repeated-line pair.
// test-category: pure-logic
#[test]
fn line_diff_edge_cases() {
    // (before, after, changed lines)
    for (before, after, expected) in [
        (
            &b"same\r\nold\r\nkeep\r\n"[..],
            &b"same\r\nnew\r\nkeep\r\n"[..],
            [
                line("deleted", Some(2), None, "old"),
                line("added", None, Some(2), "new"),
            ],
        ),
        (
            &b"a\nb"[..],
            &b"b\na"[..],
            [
                line("deleted", Some(1), None, "a"),
                line("added", None, Some(2), "a"),
            ],
        ),
        (
            &b"a\rb"[..],
            &b"a\rc"[..],
            [
                line("deleted", Some(1), None, "a\rb"),
                line("added", None, Some(1), "a\rc"),
            ],
        ),
        (
            &b"a\r"[..],
            &b"b\r"[..],
            [
                line("deleted", Some(1), None, "a\r"),
                line("added", None, Some(1), "b\r"),
            ],
        ),
    ] {
        assert_lines(&detail(before, after, false).lines, &expected);
    }

    let value = detail(
        b"same\r\nold\r\nkeep\r\n",
        b"same\r\nnew\r\nkeep\r\n",
        false,
    );
    assert_eq!(value.before_text, "same\r\nold\r\nkeep\r\n");
    assert_eq!(value.after_text, "same\r\nnew\r\nkeep\r\n");
    assert_eq!(value.additions, 1);
    assert_eq!(value.deletions, 1);

    assert!(
        changed_file(
            "synthetic.txt",
            &[0xff, b'a'],
            &[0xfe, b'a'],
            FileOrigin::Existing
        )
        .is_none()
    );
    let replacement = detail(&[0xe1, 0x80, b'A'], &[0xe1, 0x80, b'B'], false);
    assert_eq!(replacement.before_text, "�A");
    assert_eq!(replacement.after_text, "�B");

    assert!(changed_file("synthetic.txt", b"same\n", b"same\n", FileOrigin::Existing).is_none());
    let value = detail(b"", b"", true);
    assert_eq!(value.additions, 0);
    assert_eq!(value.deletions, 0);
    assert!(value.file_created);
    assert!(value.lines.is_empty());

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

    let values = source_values();
    let mut hash = Sha256::new();
    let mut checked = 0;
    for before in &values {
        for after in &values {
            let detail = changed_file(
                "synthetic.txt",
                before.as_bytes(),
                after.as_bytes(),
                FileOrigin::Existing,
            );
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

use super::*;

pub(in crate::btcc) fn segment_table() {
    for (line, expected) in [
        (
            "echo a'b' | cat",
            Some(vec![vec!["echo", "ab"], vec!["cat"]]),
        ),
        ("ls 2>/dev/null", Some(vec![vec!["ls"]])),
        (
            "ls >nul",
            butler_platform::command_sandbox::WINDOWS_SHELL.then_some(vec![vec!["ls"]]),
        ),
        ("ls &", None),
        ("FOO=1 ls", None),
        ("ls\u{a0}x", None),
    ] {
        let parsed = segments(line);
        let actual = parsed.as_ref().map(|segments| {
            segments
                .iter()
                .map(|words| {
                    words
                        .iter()
                        .map(|word| word.text.as_str())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        });
        assert_eq!(actual, expected, "{line}");
    }
}

pub(in crate::btcc) fn read_only_table() {
    for (line, expected) in [
        ("git status && git log --oneline -3 | head -1", false),
        ("grep -rn x src | wc -l", false),
        ("ls 2>/dev/null", true),
        ("find . -name a -delete", false),
        ("find . -exec rm {} ;", false),
        ("rg --pre cat x", false),
        ("rg --hostname-bin x", false),
        ("sort -uo out a", false),
        ("sort --compress=gzip a", false),
        ("fd -X rm", false),
        ("grep -f/x y", false),
        ("gc -Path:C:/x", false),
        ("git -c a=b status", false),
        ("git diff --out=f", false),
        ("sed -n 1p a", false),
        ("cat a > b", false),
        ("echo $(id)", false),
        ("ls &", false),
        ("FOO=1 ls", false),
        ("ls\u{a0}x", false),
    ] {
        assert_eq!(is_read_only(line), expected, "{line}");
    }
}

pub(in crate::btcc) fn rule_prefix_table() {
    for (line, prefix) in [
        ("git commit -m \"fix it\"", Some("git commit")),
        ("npm run build", Some("npm run")),
        ("python -m pytest -q", Some("python -m pytest")),
        ("bash -c ls", None),
        ("npx x", None),
        ("ssh h", None),
        ("./gradlew build", None),
        ("git -C x status", None),
    ] {
        assert_eq!(
            rule_prefixes(line),
            prefix.map(|prefix| vec![prefix.to_owned()]),
            "{line}"
        );
    }
}

pub(in crate::btcc) fn normalize_prefix_table() {
    for (line, expected) in [
        ("git", None),
        ("python", None),
        ("npm", None),
        (
            "git status",
            Some(vec!["git".to_owned(), "status".to_owned()]),
        ),
    ] {
        assert_eq!(normalize_prefix(line), expected, "{line}");
    }
}

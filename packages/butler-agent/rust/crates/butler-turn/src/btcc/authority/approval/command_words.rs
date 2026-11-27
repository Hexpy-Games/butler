#[derive(Debug, PartialEq, Eq)]
pub struct Word {
    pub text: String,
    pub quoted: bool,
    pub glob: bool,
}

const LAUNCHERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "pwsh",
    "powershell",
    "cmd",
    "env",
    "sudo",
    "doas",
    "su",
    "xargs",
    "eval",
    "exec",
    "nohup",
    "time",
    "nice",
    "timeout",
    "command",
    "builtin",
    "source",
    ".",
    "start-process",
    "invoke-expression",
    "iex",
    "npx",
    "bunx",
    "uvx",
    "awk",
    "sed",
    "osascript",
    "ssh",
    "wsl",
];

pub fn segments(line: &str) -> Option<Vec<Vec<Word>>> {
    let mut segments = Vec::new();
    let mut words = Vec::new();
    let mut rest = line;
    while let Some(ch) = rest.chars().next() {
        match ch {
            ' ' | '\t' => rest = &rest[1..],
            '|' | '&' | ';' | '\n' => {
                let separator = match ch {
                    '|' if rest.starts_with("||") => 2,
                    '&' if rest.starts_with("&&") => 2,
                    '&' => return None,
                    _ => 1,
                };
                segments.push(finish_segment(std::mem::take(&mut words))?);
                rest = &rest[separator..];
            }
            _ => {
                if let Some(redirect) = redirect(rest) {
                    rest = &rest[redirect.len()..];
                } else {
                    let (word, tail) = word(rest)?;
                    words.push(word);
                    rest = tail;
                }
            }
        }
    }
    segments.push(finish_segment(words)?);
    Some(segments)
}

fn finish_segment(words: Vec<Word>) -> Option<Vec<Word>> {
    let first = words.first()?;
    (!first.text.is_empty() && !first.text.contains('=')).then_some(words)
}

fn boundary(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '|' | '&' | ';' | '\n')
}

fn redirect(rest: &str) -> Option<&'static str> {
    ["2>&1", ">/dev/null", "1>/dev/null", "2>/dev/null"]
        .into_iter()
        .chain(
            butler_platform::command_sandbox::WINDOWS_SHELL
                .then_some([">nul", "2>nul"])
                .into_iter()
                .flatten(),
        )
        .find(|token| {
            rest.strip_prefix(token)
                .is_some_and(|tail| tail.chars().next().is_none_or(boundary))
        })
}

fn word(rest: &str) -> Option<(Word, &str)> {
    let mut word = Word {
        text: String::new(),
        quoted: false,
        glob: false,
    };
    let mut quote = None;
    let mut home = false;
    let mut end = rest.len();
    for (offset, ch) in rest.char_indices() {
        if quote.is_none() && boundary(ch) {
            end = offset;
            break;
        }
        if (ch.is_control() || ch.is_whitespace()) && !matches!(ch, ' ' | '\t') {
            return None;
        }
        match quote {
            Some(open) if ch == open => quote = None,
            Some('"') if matches!(ch, '$' | '`' | '\\') => return None,
            Some(_) => word.text.push(ch),
            None if matches!(ch, '\'' | '"') => {
                word.quoted = true;
                quote = Some(ch);
            }
            None if ch == '~' && offset == 0 => {
                home = true;
                word.text.push(ch);
            }
            None if ch == '\\'
                && butler_platform::command_sandbox::WINDOWS_SHELL
                && offset == 1
                && home =>
            {
                word.text.push(ch);
            }
            None if "$`\\(){}<>!%^@~#".contains(ch) => return None,
            None => {
                word.glob |= matches!(ch, '*' | '?' | '[');
                word.text.push(ch);
            }
        }
    }
    if quote.is_some()
        || home
            && (word.quoted
                || !(word.text == "~"
                    || word.text.starts_with("~/")
                    || butler_platform::command_sandbox::WINDOWS_SHELL
                        && word.text.starts_with("~\\")))
    {
        return None;
    }
    Some((word, &rest[end..]))
}

pub(in crate::btcc) fn program(word: &str) -> String {
    let name = word
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

fn option(word: &str) -> bool {
    word.starts_with('-')
        || butler_platform::command_sandbox::WINDOWS_SHELL && word.starts_with('/')
}

fn option_hits(word: &str, forbidden: &str) -> bool {
    if let Some(name) = word.strip_prefix("--") {
        let name = name.split('=').next().unwrap_or_default();
        return !name.is_empty()
            && forbidden
                .strip_prefix("--")
                .is_some_and(|full| full.starts_with(name));
    }
    if let Some(cluster) = word.strip_prefix('-') {
        return forbidden
            .strip_prefix('-')
            .is_some_and(|flag| flag.len() == 1 && cluster.contains(flag));
    }
    butler_platform::command_sandbox::WINDOWS_SHELL
        && word.starts_with('/')
        && forbidden.starts_with('/')
        && word
            .split(':')
            .next()
            .is_some_and(|flag| flag.eq_ignore_ascii_case(forbidden))
}

pub(in crate::btcc) fn read_only(words: &[Word], first_segment: bool) -> bool {
    let Some((first, args)) = words.split_first() else {
        return false;
    };
    if first.quoted
        || first.text.contains(['/', '\\'])
        || words.iter().any(|word| word.glob)
        || args
            .iter()
            .any(|word| option(&word.text) && word.text[1..].contains(['/', '\\', ':']))
    {
        return false;
    }
    let name = program(&first.text);
    // POSIX command lookup distinguishes case and does not add .exe.
    if !butler_platform::command_sandbox::WINDOWS_SHELL && name != first.text {
        return false;
    }
    let forbidden: &[&str] = match name.as_str() {
        "ls" | "dir" | "pwd" | "echo" | "printf" | "cat" | "type" | "head" | "tail" | "wc"
        | "nl" | "cut" | "tr" | "basename" | "dirname" | "realpath" | "readlink" | "stat"
        | "du" | "df" | "which" | "where" | "whoami" | "get-childitem" | "gci" | "get-location"
        | "test-path" | "resolve-path" | "measure-object" | "select-object" | "sort-object" => &[],
        "grep" | "egrep" | "fgrep" => &[
            "-r",
            "-R",
            "--recursive",
            "--dereference-recursive",
            "-d",
            "--directories",
        ],
        "findstr" => &["/S"],
        "get-content" | "gc" | "select-string" | "sls" if first_segment => &[],
        "file" => &["-C", "--compile"],
        "tree" => &["-o"],
        "sort" => &["-o", "--output", "--compress-program", "/O"],
        "uniq" => {
            let mut flags = true;
            return args
                .iter()
                .filter(|word| {
                    if flags && word.text == "--" {
                        flags = false;
                        return false;
                    }
                    !flags || word.text == "-" || !option(&word.text)
                })
                .count()
                <= 1;
        }
        "date" => &["-s", "--set"],
        "fd" => &["-x", "-X", "--exec", "--exec-batch"],
        "find" => {
            return !args.iter().any(|word| {
                [
                    "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0",
                    "-fprintf", "-fls",
                ]
                .contains(&word.text.as_str())
            });
        }
        _ => return false,
    };
    !args
        .iter()
        .any(|word| forbidden.iter().any(|flag| option_hits(&word.text, flag)))
}

pub(in crate::btcc) fn is_read_only(line: &str) -> bool {
    segments(line).is_some_and(|segments| {
        segments
            .iter()
            .enumerate()
            .all(|(index, words)| read_only(words, index == 0))
    })
}

pub(in crate::btcc) fn rule_prefix(words: &[String]) -> Option<Vec<String>> {
    let first = words.first()?;
    if first.is_empty() || first.contains(['/', '\\', '\'', '"']) {
        return None;
    }
    let name = program(first);
    if LAUNCHERS.contains(&name.as_str()) {
        return None;
    }
    let mut prefix = vec![name];
    match prefix.first()?.as_str() {
        "git" | "npm" | "pnpm" | "yarn" | "bun" | "cargo" | "go" | "docker" | "kubectl" | "gh"
        | "dotnet" | "brew" | "pip" | "pip3" | "uv" | "poetry" | "make" | "terraform" => {
            let sub = words.get(1)?.as_str();
            if sub.starts_with(['-', '+']) {
                return None;
            }
            prefix.push(sub.to_owned());
        }
        "python" | "python3" | "py" | "node" | "deno" | "ruby" | "perl" => {
            if words.get(1)? != "-m" {
                return None;
            }
            prefix.extend_from_slice(words.get(1..3)?);
        }
        _ => {}
    }
    Some(prefix)
}

pub(in crate::btcc) fn segment_prefix(words: &[Word]) -> Option<Vec<String>> {
    if words.first()?.quoted || words.iter().any(|word| word.glob) {
        return None;
    }
    let prefix = rule_prefix(
        &words
            .iter()
            .map(|word| word.text.clone())
            .collect::<Vec<_>>(),
    )?;
    // Stored prefixes use single-space delimiters; each word must survive storage.
    (normalize_prefix(&prefix.join(" ")).as_ref() == Some(&prefix)).then_some(prefix)
}

pub(in crate::btcc) fn normalize_prefix(text: &str) -> Option<Vec<String>> {
    let parsed = segments(text)?;
    let [words] = parsed.as_slice() else {
        return None;
    };
    if words.first()?.quoted || words.iter().any(|word| word.glob) {
        return None;
    }
    let prefix: Vec<_> = words.iter().map(|word| word.text.clone()).collect();
    if prefix
        .iter()
        .any(|word| word.is_empty() || word.chars().any(char::is_whitespace))
        || rule_prefix(&prefix).as_ref() != Some(&prefix)
        || !segments(&prefix.join(" ")).is_some_and(|segments| {
            matches!(segments.as_slice(), [words] if words.iter().map(|word| &word.text).eq(&prefix))
        })
    {
        return None;
    }
    Some(prefix)
}

/// Reject single quotes for rule parsing after stripping a wrapper because cmd.exe treats them as literals.
pub(in crate::btcc) fn rule_script(command: &str) -> (&str, bool) {
    let stripped = butler_platform::command_sandbox::path_script(command);
    let parsable = stripped == command || !stripped.contains('\'');
    (stripped, parsable)
}

pub(in crate::btcc) fn rule_prefixes(line: &str) -> Option<Vec<String>> {
    let (line, parsable) = rule_script(line);
    if !parsable {
        return None;
    }
    let mut prefixes = Vec::new();
    for (index, words) in segments(line)?.into_iter().enumerate() {
        if !read_only(&words, index == 0) {
            let prefix = segment_prefix(&words)?.join(" ");
            if !prefixes.contains(&prefix) {
                prefixes.push(prefix);
            }
        }
    }
    (!prefixes.is_empty()).then_some(prefixes)
}

#[cfg(test)]
pub(super) mod tests;

use super::{PathSyntax, expansion};
use std::{collections::HashMap, iter::Peekable, str::Chars};

pub(super) struct Word {
    pub text: String,
    pub known: bool,
    pub glob: bool,
    pub path: bool,
}
impl Default for Word {
    fn default() -> Self {
        Self {
            text: String::new(),
            known: true,
            glob: false,
            path: true,
        }
    }
}

pub(super) struct Segment {
    pub text: String,
    pub before: String,
    pub after: String,
}
impl Segment {
    pub(super) fn carries_directory(&self) -> bool {
        !["|", "&", "||", "&&"].contains(&self.before.as_str())
            && ["", ";", "&&", "\n"].contains(&self.after.as_str())
    }
}

// Preserve shell operators: a pipeline/background location change cannot
// establish the next command's working directory.
pub(super) fn segments(command: &str, syntax: PathSyntax) -> Vec<Segment> {
    let mut result = Vec::new();
    let mut text = String::new();
    let mut before = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if quote.is_none() && !escaped && [';', '&', '|', '\n'].contains(&ch) {
            let mut after = ch.to_string();
            if ['&', '|'].contains(&ch) && chars.peek() == Some(&ch) {
                chars.next();
                after.push(ch);
            }
            if text.trim().is_empty()
                && after == "\n"
                && ["|", "&&", "||"].contains(&before.as_str())
            {
                continue;
            }
            if !text.trim().is_empty() {
                result.push(Segment {
                    text: std::mem::take(&mut text),
                    before,
                    after: after.clone(),
                });
            }
            before = after;
            continue;
        }
        text.push(ch);
        if escaped {
            escaped = false;
            continue;
        }
        if ch == escape(syntax) && quote != Some('\'') {
            escaped = true;
        } else if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && (ch == '"' || ch == '\'' && syntax != PathSyntax::Cmd) {
            quote = Some(ch);
        }
    }
    if !text.trim().is_empty() {
        result.push(Segment {
            text,
            before,
            after: String::new(),
        });
    }
    result
}

pub(super) fn expand(
    segment: &str,
    env: &HashMap<String, String>,
    syntax: PathSyntax,
) -> Vec<Word> {
    let mut words = parse(segment, env, syntax, true);
    let mut pattern = false;
    for word in words.iter_mut().skip(1) {
        if pattern {
            word.path = false;
            pattern = false;
            continue;
        }
        let option = word
            .text
            .split_once('=')
            .map_or(word.text.as_str(), |(name, _)| name);
        if word.text.starts_with("-g") && word.text.len() > 2 && !word.text.starts_with("--") {
            word.path = false;
            continue;
        }
        if [
            "-name",
            "-iname",
            "-path",
            "-ipath",
            "-regex",
            "-iregex",
            "--include",
            "--exclude",
            "--exclude-dir",
            "-g",
            "--glob",
            "--iglob",
        ]
        .contains(&option)
        {
            word.path = false;
            pattern = !word.text.contains('=');
        }
    }
    words
}

pub(super) fn token(
    segment: &str,
    env: &HashMap<String, String>,
    syntax: PathSyntax,
) -> Option<Word> {
    let mut words = parse(segment, env, syntax, false);
    normalize(&mut words, syntax);
    words.pop()
}

fn parse(
    segment: &str,
    env: &HashMap<String, String>,
    syntax: PathSyntax,
    split: bool,
) -> Vec<Word> {
    let mut words = Vec::new();
    let mut word = Word::default();
    let mut quote = None;
    let mut started = false;
    let mut chars = segment.chars().peekable();
    while let Some(ch) = chars.next() {
        if split && quote.is_none() && ['(', ')', '{', '}', '#'].contains(&ch) {
            words.push(Word {
                text: ch.to_string(),
                known: false,
                ..Default::default()
            });
        }
        if split
            && quote.is_none()
            && (ch.is_whitespace() || ['>', '<', ',', '(', ')'].contains(&ch))
        {
            if started {
                words.push(word);
                word = Word::default();
                started = false;
            }
            continue;
        }
        started = true;
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_none() && (ch == '"' || ch == '\'' && syntax != PathSyntax::Cmd) {
            quote = Some(ch);
            continue;
        }
        if ch == escape(syntax) && quote != Some('\'') {
            if let Some(next) = chars.next() {
                if syntax == PathSyntax::Posix
                    && quote == Some('"')
                    && !['$', '`', '"', '\\', '\n'].contains(&next)
                {
                    word.text.push(ch);
                }
                if next != '\n' {
                    word.text.push(next);
                }
            } else {
                word.known = false;
            }
            continue;
        }
        append(ch, &mut chars, &mut word, quote, env, syntax);
    }
    if quote.is_some() {
        word.known = false;
    }
    if started {
        words.push(word);
    }
    words
}

// Normalize only after location shorthand recognition, which depends on the
// original separator (PowerShell cd\ is a function; cd/ is not).
pub(super) fn normalize(words: &mut [Word], syntax: PathSyntax) {
    if syntax != PathSyntax::Posix {
        for word in words {
            word.text = word.text.replace('\\', "/");
        }
    }
}

fn append(
    ch: char,
    chars: &mut Peekable<Chars<'_>>,
    word: &mut Word,
    quote: Option<char>,
    env: &HashMap<String, String>,
    syntax: PathSyntax,
) {
    if ch == '`' && syntax == PathSyntax::Posix {
        word.known = false;
    }
    if quote != Some('\'') && ch == '$' && syntax != PathSyntax::Cmd {
        let (value, known) = expansion::dollar(chars, env, syntax);
        word.text.push_str(&value);
        word.known &= known;
        return;
    }
    if ch == '%' && syntax == PathSyntax::Cmd {
        let name: String = chars.by_ref().take_while(|ch| *ch != '%').collect();
        let value = expansion::value(env, &name, syntax);
        word.known &= value.is_some();
        word.text.push_str(
            &value
                .map(str::to_owned)
                .unwrap_or_else(|| format!("%{name}%")),
        );
        return;
    }
    if ch == '~' && word.text.is_empty() && quote.is_none() {
        if chars.peek().is_some_and(|ch| !['/', '\\'].contains(ch)) {
            word.known = false;
            word.text.push('~');
            return;
        }
        if let Some(home) = expansion::home(env, syntax) {
            word.text.push_str(home);
        } else {
            word.known = false;
            word.text.push('~');
        }
        return;
    }
    word.glob |=
        ['*', '?', '['].contains(&ch) && (quote.is_none() || syntax == PathSyntax::PowerShell);
    word.text.push(ch);
}
fn escape(syntax: PathSyntax) -> char {
    match syntax {
        PathSyntax::Posix => '\\',
        PathSyntax::PowerShell => '`',
        PathSyntax::Cmd => '^',
    }
}

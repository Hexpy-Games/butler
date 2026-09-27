//! Match the glob syntax reached by file-tools after slash normalization.

use regex::Regex;

pub(super) struct WorkspaceGlob {
    matcher: Option<Regex>,
    negate: bool,
    basename: bool,
}

impl WorkspaceGlob {
    pub(super) fn new(pattern: &str) -> Self {
        let negate = pattern.starts_with('!');
        let body = pattern.strip_prefix('!').unwrap_or(pattern);
        let basename = !body.contains('/');
        let mut parser = GlobParser {
            chars: body.chars().collect(),
            at: 0,
        };
        let source = parser
            .sequence(0, Scope::Pattern)
            .filter(|_| parser.at == parser.chars.len())
            .map(|body| format!("^{body}$"));
        Self {
            matcher: source.and_then(|pattern| Regex::new(&pattern).ok()),
            negate,
            basename,
        }
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        let Some(matcher) = &self.matcher else {
            return false;
        };
        let matches = |candidate| matcher.is_match(candidate) != self.negate;
        matches(path) || (self.basename && matches(path.rsplit('/').next().unwrap_or(path)))
    }
}

/// Where a glob sequence is parsed: the whole pattern, or one alternative of
/// a `{a,b}` group (which ends at `,` or `}`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Pattern,
    Alternative,
}

/// Translates a glob into a regex source; `None` for malformed globs.
struct GlobParser {
    chars: Vec<char>,
    at: usize,
}

impl GlobParser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn sequence(&mut self, depth: usize, scope: Scope) -> Option<String> {
        let mut output = String::new();
        while let Some(character) = self.peek() {
            if scope == Scope::Alternative && matches!(character, ',' | '}') {
                break;
            }
            match character {
                '{' => output.push_str(&self.alternatives(depth)?),
                '[' => output.push_str(&self.class()?),
                '*' => output.push_str(self.stars()),
                '?' => {
                    output.push_str("[^/]");
                    self.at += 1;
                }
                _ => {
                    output.push_str(&regex::escape(&character.to_string()));
                    self.at += 1;
                }
            }
        }
        Some(output)
    }

    /// `{a,b,..}`, nested at most ten deep.
    fn alternatives(&mut self, depth: usize) -> Option<String> {
        self.at += 1;
        if depth >= 10 {
            return None;
        }
        let mut alternatives = Vec::new();
        loop {
            alternatives.push(self.sequence(depth + 1, Scope::Alternative)?);
            match self.peek() {
                Some(',') => self.at += 1,
                Some('}') => {
                    self.at += 1;
                    break;
                }
                _ => return None,
            }
        }
        Some(format!("(?:{})", alternatives.join("|")))
    }

    /// `[..]` / `[!..]` / `[^..]` with regex metacharacters escaped; a leading
    /// `]` is a member.
    fn class(&mut self) -> Option<String> {
        self.at += 1;
        let mut output = String::from("[");
        if matches!(self.peek(), Some('!' | '^')) {
            output.push('^');
            self.at += 1;
        }
        let mut members = 0;
        while let Some(member) = self.peek() {
            if member == ']' && members > 0 {
                break;
            }
            if member == ']' && self.chars.get(self.at + 1).is_none() {
                return None;
            }
            if matches!(member, '[' | ']' | '\\' | '^') {
                output.push('\\');
            }
            output.push(member);
            members += 1;
            self.at += 1;
        }
        if members == 0 || self.peek() != Some(']') {
            return None;
        }
        output.push(']');
        self.at += 1;
        Some(output)
    }

    /// `*` within a segment, or a whole `**` segment spanning directories.
    fn stars(&mut self) -> &'static str {
        let start = self.at;
        while self.peek() == Some('*') {
            self.at += 1;
        }
        let segment_start = start
            .checked_sub(1)
            .is_none_or(|before| self.chars.get(before) == Some(&'/'));
        let whole_globstar =
            self.at - start == 2 && segment_start && matches!(self.peek(), None | Some('/'));
        if whole_globstar && self.peek() == Some('/') {
            self.at += 1;
            "(?:[^/]+/)*"
        } else if whole_globstar {
            "(?s:.*)"
        } else {
            "[^/]*"
        }
    }
}

/// The directory prefix of a `prefix/*` or `prefix/**` exclusion, whose
/// whole subtree can be pruned.
pub(super) fn prune_prefix(pattern: &str) -> Option<&str> {
    for (index, _) in pattern.match_indices("/*") {
        let (Some(prefix), Some(suffix)) = (pattern.get(..index), pattern.get(index + 2..)) else {
            continue;
        };
        let suffix = suffix.strip_prefix('*').unwrap_or(suffix);
        if suffix.is_empty() || suffix.starts_with('/') {
            return Some(prefix);
        }
    }
    None
}

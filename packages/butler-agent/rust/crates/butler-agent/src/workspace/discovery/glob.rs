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
        let characters: Vec<char> = body.chars().collect();
        let mut at = 0;
        let source = sequence(&characters, &mut at, 0, false)
            .filter(|_| at == characters.len())
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

fn sequence(chars: &[char], at: &mut usize, depth: usize, in_brace: bool) -> Option<String> {
    let mut output = String::new();
    while let Some(&character) = chars.get(*at) {
        if in_brace && matches!(character, ',' | '}') {
            break;
        }
        match character {
            '{' => {
                *at += 1;
                if depth >= 10 {
                    return None;
                }
                let mut alternatives = Vec::new();
                loop {
                    alternatives.push(sequence(chars, at, depth + 1, true)?);
                    match chars.get(*at) {
                        Some(',') => *at += 1,
                        Some('}') => {
                            *at += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
                output.push_str("(?:");
                output.push_str(&alternatives.join("|"));
                output.push(')');
            }
            '[' => {
                *at += 1;
                output.push('[');
                if matches!(chars.get(*at).copied(), Some('!' | '^')) {
                    output.push('^');
                    *at += 1;
                }
                let mut members = 0;
                while let Some(&member) = chars.get(*at) {
                    if member == ']' && members > 0 {
                        break;
                    }
                    if member == ']' && chars.get(*at + 1).is_none() {
                        return None;
                    }
                    match member {
                        '[' | ']' | '\\' | '^' => {
                            output.push('\\');
                            output.push(member);
                        }
                        _ => output.push(member),
                    }
                    members += 1;
                    *at += 1;
                }
                if members == 0 || chars.get(*at) != Some(&']') {
                    return None;
                }
                output.push(']');
                *at += 1;
            }
            '*' => {
                let start = *at;
                while chars.get(*at) == Some(&'*') {
                    *at += 1;
                }
                let whole_globstar = *at - start == 2
                    && (start == 0 || chars[start - 1] == '/')
                    && matches!(chars.get(*at), None | Some('/'));
                if whole_globstar && chars.get(*at) == Some(&'/') {
                    output.push_str("(?:[^/]+/)*");
                    *at += 1;
                } else if whole_globstar {
                    output.push_str("(?s:.*)");
                } else {
                    output.push_str("[^/]*");
                }
            }
            '?' => {
                output.push_str("[^/]");
                *at += 1;
            }
            _ => {
                output.push_str(&regex::escape(&character.to_string()));
                *at += 1;
            }
        }
    }
    Some(output)
}

pub(super) fn prune_prefix(pattern: &str) -> Option<&str> {
    for (index, _) in pattern.match_indices("/*") {
        let suffix = &pattern[index + 2..];
        let suffix = suffix.strip_prefix('*').unwrap_or(suffix);
        if suffix.is_empty() || suffix.starts_with('/') {
            return Some(&pattern[..index]);
        }
    }
    None
}

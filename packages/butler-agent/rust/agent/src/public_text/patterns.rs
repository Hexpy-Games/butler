use std::borrow::Cow;

use regex::Regex;

// Rust's Unicode \s and \b differ from ECMAScript /u. Spell out JS whitespace
// and check JS word boundaries on the original text, including /iu folding.
const SPACE: &str = r"[\x09-\x0d\x20\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

pub(super) struct Patterns {
    pub secrets: BoundaryPattern,
    pub bearer: BoundaryPattern,
    private: Vec<BoundaryPattern>,
    json_start: Regex,
    json_key: Regex,
}

impl Patterns {
    pub(super) fn new() -> Self {
        let nonspace_no_slash = format!(r"[^{}\\]", &SPACE[1..SPACE.len() - 1]);
        let nonspace = SPACE.replacen('[', "[^", 1);
        Self {
            secrets: BoundaryPattern::new(
                &format!(
                    r"(?:api[_-]?key|token|secret|password|database_url|db_url){SPACE}*[:=]{SPACE}*{nonspace}+|(?:auth|authorization){SPACE}*[:=]{SPACE}*(?:bearer{SPACE}+)?{nonspace}+"
                ),
                true,
                true,
                None,
            ),
            bearer: BoundaryPattern::new(
                &format!(r"bearer{SPACE}+[a-z0-9_.~+/=\-]+"),
                true,
                true,
                None,
            ),
            private: vec![
                BoundaryPattern::new(
                    &format!(r"<{SPACE}*/?{SPACE}*(thinking|reasoning|think)[^>]*>"),
                    true,
                    false,
                    Some(1),
                ),
                BoundaryPattern::new(
                    r"<\|?(?:channel|start|message|assistant|analysis|final)[^>]*\|?>",
                    true,
                    false,
                    None,
                ),
                BoundaryPattern::new(
                    r"hidden reasoning|chain[- ]of[- ]thought|scratchpad|internal plan|let me think|let's think|i need to think|we need to think|step[- ]by[- ]step reasoning",
                    true,
                    true,
                    Some(0),
                ),
                BoundaryPattern::new(
                    r"tool_call|tool_result|argumentsJson|raw transcript|sessionId|eventId|FileNotFoundException|root_path|butler-workers|ENOENT",
                    false,
                    true,
                    Some(0),
                ),
                BoundaryPattern::new(
                    &format!(
                        r#"(?:^|{SPACE}|["'`:=])/(Users|private|tmp|var/folders|home|Volumes|opt|usr|etc)"#
                    ),
                    false,
                    false,
                    Some(1),
                ),
                BoundaryPattern::new(
                    &format!(
                        r#"(?:^|{SPACE}|["'`:=])(?:[A-Za-z]:\\|\\\\{nonspace_no_slash}+\\{nonspace_no_slash}+)"#
                    ),
                    false,
                    false,
                    None,
                ),
            ],
            json_start: Regex::new(&format!(r"^{SPACE}*[\{{\[]"))
                .expect("fixed public text pattern"),
            json_key: Regex::new(r#""(?:eventId|sessionId|payload|arguments|tool_call)""#)
                .expect("fixed public text pattern"),
        }
    }

    pub(super) fn is_private(&self, text: &str) -> bool {
        self.private.iter().any(|pattern| pattern.find(text))
            || self.json_start.is_match(text) && self.json_key.is_match(text)
    }
}

pub(super) struct BoundaryPattern {
    regex: Regex,
    insensitive: bool,
    before: bool,
    after_capture: Option<usize>,
}

impl BoundaryPattern {
    fn new(pattern: &str, insensitive: bool, before: bool, after_capture: Option<usize>) -> Self {
        let regex = regex::RegexBuilder::new(pattern)
            .case_insensitive(insensitive)
            .build()
            .expect("fixed public text pattern");
        Self {
            regex,
            insensitive,
            before,
            after_capture,
        }
    }

    fn valid(&self, text: &str, captures: &regex::Captures<'_>) -> bool {
        let whole = captures.get(0).expect("whole regex match");
        (!self.before || boundary(text, whole.start(), self.insensitive))
            && self.after_capture.is_none_or(|index| {
                boundary(
                    text,
                    captures.get(index).expect("fixed capture").end(),
                    self.insensitive,
                )
            })
    }

    fn find(&self, text: &str) -> bool {
        let mut offset = 0;
        while let Some(captures) = self.regex.captures_at(text, offset) {
            if self.valid(text, &captures) {
                return true;
            }
            offset = next_offset(text, &captures);
        }
        false
    }

    pub(super) fn replace<'a>(&self, text: &'a str, replacement: &str) -> Cow<'a, str> {
        let mut output = None::<String>;
        let mut copied = 0;
        let mut offset = 0;
        while let Some(captures) = self.regex.captures_at(text, offset) {
            if !self.valid(text, &captures) {
                offset = next_offset(text, &captures);
                continue;
            }
            let matched = captures.get(0).expect("whole regex match");
            let target = output.get_or_insert_with(|| String::with_capacity(text.len()));
            target.push_str(&text[copied..matched.start()]);
            target.push_str(replacement);
            copied = matched.end();
            offset = copied;
        }
        match output {
            Some(mut output) => {
                output.push_str(&text[copied..]);
                Cow::Owned(output)
            }
            None => Cow::Borrowed(text),
        }
    }
}

fn boundary(text: &str, offset: usize, insensitive: bool) -> bool {
    let word = |character: char| {
        character.is_ascii_alphanumeric()
            || character == '_'
            || insensitive && matches!(character, '\u{17f}' | '\u{212a}')
    };
    text[..offset].chars().next_back().is_some_and(word)
        != text[offset..].chars().next().is_some_and(word)
}

fn next_offset(text: &str, captures: &regex::Captures<'_>) -> usize {
    let start = captures.get(0).expect("whole regex match").start();
    start
        + text[start..]
            .chars()
            .next()
            .expect("nonempty fixed match")
            .len_utf8()
}

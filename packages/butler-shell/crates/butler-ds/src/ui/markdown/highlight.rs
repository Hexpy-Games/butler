//! Code highlighting with syntect (pure-Rust regex): only the grammars `syntaxHighlighter.ts`
//! registers with lowlight, under the same aliases, each token mapped to a `--syntax-*` role.
use std::ops::Range;
use std::sync::OnceLock;

use syntect::easy::ScopeRangeIterator;
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use super::scopes::{Role, role};

/// A highlighted byte range of the code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub range: Range<usize>,
    pub role: Role,
}

/// A grammar `syntaxHighlighter.ts` registers and the syntect syntax that stands for it.
struct Grammar {
    /// The names lowlight resolves to it: hljs's own aliases and `registerAlias`'s.
    names: &'static [&'static str],
    /// A file extension of the syntect syntax.
    extension: &'static str,
}

const GRAMMARS: &[Grammar] = &[
    Grammar {
        names: &["bash", "sh", "zsh", "shell", "console"],
        extension: "sh",
    },
    Grammar {
        names: &["css"],
        extension: "css",
    },
    Grammar {
        names: &["diff", "patch"],
        extension: "diff",
    },
    Grammar {
        names: &["go", "golang"],
        extension: "go",
    },
    Grammar {
        names: &["javascript", "js", "jsx", "mjs", "cjs"],
        extension: "js",
    },
    Grammar {
        names: &["json", "jsonc"],
        extension: "json",
    },
    Grammar {
        names: &["markdown", "md", "mkdown", "mkd"],
        extension: "md",
    },
    Grammar {
        names: &["python", "py", "gyp", "ipython"],
        extension: "py",
    },
    Grammar {
        names: &["rust", "rs"],
        extension: "rs",
    },
    // syntect ships no TypeScript: the JavaScript syntax, plus the words only TypeScript has.
    Grammar {
        names: &["typescript", "ts", "tsx", "mts", "cts"],
        extension: "js",
    },
    Grammar {
        names: &[
            "xml", "xhtml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "wsf", "svg",
        ],
        extension: "xml",
    },
    // lowlight's xml grammar also draws html; syntect has its own HTML syntax.
    Grammar {
        names: &["html"],
        extension: "html",
    },
    Grammar {
        names: &["yaml", "yml"],
        extension: "yaml",
    },
];

/// Names `lowlight.registered` knows.
const TYPESCRIPT: &[&str] = &["typescript", "ts", "tsx", "mts", "cts"];

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn grammar(language: &str) -> Option<&'static Grammar> {
    let name = language.to_ascii_lowercase();
    GRAMMARS
        .iter()
        .find(|grammar| grammar.names.contains(&name.as_str()))
}

/// Whether `language` names a registered grammar (`lowlight.registered`).
pub fn registered(language: &str) -> bool {
    grammar(language).is_some()
}

/// The tokens of `code` in `language`, or `None` for a language no grammar is registered for.
pub fn highlight(code: &str, language: &str) -> Option<Vec<Token>> {
    let grammar = grammar(language)?;
    let set = syntaxes();
    let syntax: &SyntaxReference = set.find_syntax_by_extension(grammar.extension)?;
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut tokens: Vec<Token> = Vec::new();
    let mut offset = 0;
    for line in LinesWithEndings::from(code) {
        let ops = state.parse_line(line, set).ok()?;
        for (range, op) in ScopeRangeIterator::new(&ops, line) {
            stack.apply(op).ok()?;
            let Some(role) = role(stack.as_slice()).filter(|_| !range.is_empty()) else {
                continue;
            };
            let range = offset + range.start..offset + range.end;
            match tokens.last_mut() {
                Some(last) if last.role == role && last.range.end == range.start => {
                    last.range.end = range.end;
                }
                _ => tokens.push(Token { range, role }),
            }
        }
        offset += line.len();
    }
    if TYPESCRIPT.contains(&language.to_ascii_lowercase().as_str()) {
        tokens = typescript_words(code, tokens);
    }
    Some(tokens)
}

/// Words that are keywords in TypeScript only.
const TS_KEYWORDS: &[&str] = &[
    "interface",
    "enum",
    "namespace",
    "declare",
    "abstract",
    "implements",
    "readonly",
    "keyof",
    "satisfies",
    "private",
    "public",
    "protected",
    "infer",
];
/// Words that are keywords only before a name (`type Id`, `x as T`), and plain names elsewhere.
const TS_BEFORE_NAME: &[&str] = &["type", "as", "is", "module", "override"];
const TS_TYPES: &[&str] = &[
    "string", "number", "boolean", "void", "unknown", "never", "any", "object", "symbol", "bigint",
];

/// Adds the TypeScript-only words to the tokens of the JavaScript syntax, in the stretches the
/// syntax left plain (never inside strings or comments).
fn typescript_words(code: &str, tokens: Vec<Token>) -> Vec<Token> {
    let mut out = Vec::with_capacity(tokens.len());
    let mut cursor = 0;
    for token in tokens {
        scan(code, cursor..token.range.start, &mut out);
        cursor = token.range.end;
        out.push(token);
    }
    scan(code, cursor..code.len(), &mut out);
    out
}

fn scan(code: &str, gap: Range<usize>, out: &mut Vec<Token>) {
    let text = &code[gap.clone()];
    let mut word_start = None;
    for (index, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        let word_char = c.is_alphanumeric() || c == '_' || c == '$';
        match (word_char, word_start) {
            (true, None) => word_start = Some(index),
            (false, Some(start)) => {
                word_start = None;
                let word = &text[start..index];
                let after = &code[gap.start + index..];
                let role = ts_role(word, text[..start].chars().last(), after);
                if let Some(role) = role {
                    out.push(Token {
                        range: gap.start + start..gap.start + index,
                        role,
                    });
                }
            }
            _ => {}
        }
    }
}

fn ts_role(word: &str, before: Option<char>, after: &str) -> Option<Role> {
    if before == Some('.') {
        return None;
    }
    if TS_KEYWORDS.contains(&word) {
        return Some(Role::Keyword);
    }
    if TS_TYPES.contains(&word) {
        return Some(Role::Type);
    }
    let named = after.starts_with([' ', '\t'])
        && after
            .trim_start()
            .chars()
            .next()
            .is_some_and(char::is_alphabetic);
    (TS_BEFORE_NAME.contains(&word) && named).then_some(Role::Keyword)
}

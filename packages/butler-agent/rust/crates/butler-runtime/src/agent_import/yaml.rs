//! Hermes config.yaml: only the top-level mcp_servers block is read, as
//! plain block YAML (mappings, sequences, quoted and flow scalars). Anchors,
//! aliases and tags are refused rather than guessed.
use super::FormatError;
use serde_json::{Map, Value};

struct Line {
    indent: usize,
    text: String,
    tab: bool,
}

/// The mcp_servers mapping as JSON-shaped values.
pub(super) fn mcp_servers(text: &str) -> Result<Value, FormatError> {
    let lines = lines(text);
    let Some(start) = lines.iter().position(|line| {
        line.indent == 0 && split_key(&line.text).is_some_and(|(key, _)| key == "mcp_servers")
    }) else {
        return Ok(Value::Null);
    };
    let rest = split_key(&lines[start].text).map_or("", |(_, rest)| rest);
    if !rest.is_empty() {
        return scalar(rest);
    }
    let mut block: Vec<Line> = lines
        .into_iter()
        .skip(start + 1)
        .take_while(|line| line.indent > 0 || is_item(&line.text))
        .collect();
    if block.is_empty() {
        return Ok(Value::Null);
    }
    if block.iter().any(|line| line.tab) {
        return Err(FormatError);
    }
    let mut pos = 0;
    let indent = block[0].indent;
    let value = node(&mut block, &mut pos, indent)?;
    if pos == block.len() {
        Ok(value)
    } else {
        Err(FormatError)
    }
}

/// Content lines with comments, blank lines and document markers removed.
fn lines(text: &str) -> Vec<Line> {
    text.lines()
        .filter_map(|raw| {
            let body = raw.trim_start_matches([' ', '\t']);
            let lead = &raw[..raw.len() - body.len()];
            let body = strip_comment(body).trim_end();
            if body.is_empty() || body == "---" || body == "..." {
                return None;
            }
            Some(Line {
                indent: lead.len(),
                text: body.to_owned(),
                tab: lead.contains('\t'),
            })
        })
        .collect()
}

fn strip_comment(text: &str) -> &str {
    let mut quote = None;
    let mut previous = ' ';
    for (index, c) in text.char_indices() {
        match quote {
            Some(open) if c == open => quote = None,
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' && previous.is_whitespace() => return &text[..index],
            _ => {}
        }
        previous = c;
    }
    text
}

fn is_item(text: &str) -> bool {
    text == "-" || text.starts_with("- ")
}

/// key: rest, splitting at the first colon outside quotes that ends the key.
fn split_key(text: &str) -> Option<(String, &str)> {
    if text.starts_with(['[', '{', '-']) {
        return None;
    }
    let mut quote = None;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for (at, (index, c)) in chars.iter().copied().enumerate() {
        match quote {
            Some(open) if c == open => quote = None,
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == ':' => {
                let ends = chars
                    .get(at + 1)
                    .is_none_or(|(_, next)| next.is_whitespace());
                if ends {
                    let key = unquote(text[..index].trim())?;
                    return Some((key, text[index + 1..].trim()));
                }
            }
            _ => {}
        }
    }
    None
}

fn unquote(key: &str) -> Option<String> {
    match scalar(key).ok()? {
        Value::String(text) => Some(text),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn node(lines: &mut [Line], pos: &mut usize, indent: usize) -> Result<Value, FormatError> {
    if is_item(&lines[*pos].text) {
        sequence(lines, pos, indent)
    } else {
        mapping(lines, pos, indent)
    }
}

fn mapping(lines: &mut [Line], pos: &mut usize, indent: usize) -> Result<Value, FormatError> {
    let mut object = Map::new();
    while *pos < lines.len() && lines[*pos].indent == indent && !is_item(&lines[*pos].text) {
        let text = lines[*pos].text.clone();
        let (key, rest) = split_key(&text).ok_or(FormatError)?;
        *pos += 1;
        let next = lines
            .get(*pos)
            .map(|line| (line.indent, is_item(&line.text)));
        let value = match next {
            _ if rest.starts_with(['|', '>']) => block_scalar(lines, pos, indent, rest),
            _ if !rest.is_empty() => scalar(rest)?,
            Some((deeper, _)) if deeper > indent => node(lines, pos, deeper)?,
            Some((same, true)) if same == indent => sequence(lines, pos, indent)?,
            _ => Value::Null,
        };
        object.insert(key, value);
    }
    if lines.get(*pos).is_some_and(|line| line.indent > indent) {
        return Err(FormatError);
    }
    Ok(Value::Object(object))
}

fn sequence(lines: &mut [Line], pos: &mut usize, indent: usize) -> Result<Value, FormatError> {
    let mut items = Vec::new();
    while *pos < lines.len() && lines[*pos].indent == indent && is_item(&lines[*pos].text) {
        let text = lines[*pos].text.clone();
        let rest = text[1..].trim_start();
        if rest.is_empty() {
            *pos += 1;
            let deeper = lines.get(*pos).map_or(0, |line| line.indent);
            items.push(if deeper > indent {
                node(lines, pos, deeper)?
            } else {
                Value::Null
            });
        } else if split_key(rest).is_some() {
            // A dash followed by key: value opens a mapping aligned with the key.
            let inner = indent + text.len() - rest.len();
            lines[*pos] = Line {
                indent: inner,
                text: rest.to_owned(),
                tab: false,
            };
            items.push(mapping(lines, pos, inner)?);
        } else {
            *pos += 1;
            items.push(scalar(rest)?);
        }
    }
    Ok(Value::Array(items))
}

/// A literal block keeps line breaks; a folded block joins lines with spaces.
fn block_scalar(lines: &[Line], pos: &mut usize, indent: usize, header: &str) -> Value {
    let start = *pos;
    while lines.get(*pos).is_some_and(|line| line.indent > indent) {
        *pos += 1;
    }
    let body = &lines[start..*pos];
    let base = body.iter().map(|line| line.indent).min().unwrap_or(0);
    let parts: Vec<String> = body
        .iter()
        .map(|line| format!("{}{}", " ".repeat(line.indent - base), line.text))
        .collect();
    Value::String(parts.join(if header.starts_with('|') { "\n" } else { " " }))
}

/// A one-line value: quoted, flow list or table, or plain.
fn scalar(text: &str) -> Result<Value, FormatError> {
    let mut flow = Flow {
        chars: text.trim().chars().collect(),
        at: 0,
    };
    let value = flow.value(false)?;
    flow.space();
    if flow.at == flow.chars.len() {
        Ok(value)
    } else {
        Err(FormatError)
    }
}

struct Flow {
    chars: Vec<char>,
    at: usize,
}

impl Flow {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn space(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.at += 1;
        }
    }

    fn value(&mut self, nested: bool) -> Result<Value, FormatError> {
        self.space();
        match self.peek() {
            Some('[') => self.list(),
            Some('{') => self.table(),
            Some('"') => self.double().map(Value::String),
            Some('\'') => self.single().map(Value::String),
            Some('&' | '*' | '!' | '%' | '@' | '`' | '|' | '>') => Err(FormatError),
            _ => Ok(plain(&self.plain(nested))),
        }
    }

    fn plain(&mut self, nested: bool) -> String {
        let start = self.at;
        while let Some(c) = self.peek() {
            let ends_key = c == ':'
                && self
                    .chars
                    .get(self.at + 1)
                    .is_none_or(|next| next.is_whitespace());
            if nested && (matches!(c, ',' | ']' | '}') || ends_key) {
                break;
            }
            self.at += 1;
        }
        self.chars[start..self.at]
            .iter()
            .collect::<String>()
            .trim()
            .to_owned()
    }

    fn double(&mut self) -> Result<String, FormatError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or(FormatError)?;
            self.at += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let escaped = self.peek().ok_or(FormatError)?;
                    self.at += 1;
                    out.push(match escaped {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        '0' => '\0',
                        other => other,
                    });
                }
                other => out.push(other),
            }
        }
    }

    fn single(&mut self) -> Result<String, FormatError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or(FormatError)?;
            self.at += 1;
            if c != '\'' {
                out.push(c);
            } else if self.peek() == Some('\'') {
                self.at += 1;
                out.push(c);
            } else {
                return Ok(out);
            }
        }
    }

    fn list(&mut self) -> Result<Value, FormatError> {
        self.at += 1;
        let mut items = Vec::new();
        loop {
            self.space();
            if self.peek() == Some(']') {
                self.at += 1;
                return Ok(Value::Array(items));
            }
            items.push(self.value(true)?);
            self.space();
            match self.peek() {
                Some(',') => self.at += 1,
                Some(']') => {}
                _ => return Err(FormatError),
            }
        }
    }

    fn table(&mut self) -> Result<Value, FormatError> {
        self.at += 1;
        let mut object = Map::new();
        loop {
            self.space();
            if self.peek() == Some('}') {
                self.at += 1;
                return Ok(Value::Object(object));
            }
            let key = match self.value(true)? {
                Value::String(text) => text,
                Value::Null => return Err(FormatError),
                other => other.to_string(),
            };
            self.space();
            if self.peek() != Some(':') {
                return Err(FormatError);
            }
            self.at += 1;
            object.insert(key, self.value(true)?);
            self.space();
            match self.peek() {
                Some(',') => self.at += 1,
                Some('}') => {}
                _ => return Err(FormatError),
            }
        }
    }
}

/// YAML 1.2 core schema for plain scalars.
fn plain(text: &str) -> Value {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => Value::Null,
        "true" | "True" | "TRUE" => Value::Bool(true),
        "false" | "False" | "FALSE" => Value::Bool(false),
        _ => text
            .parse::<i64>()
            .map_or_else(|_| Value::String(text.to_owned()), Value::from),
    }
}

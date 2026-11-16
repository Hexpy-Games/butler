//! React Native token JSON, rendered from the same cells as the Rust tables.
use crate::{css::Block, output, resolve};
use std::collections::BTreeMap;

/// `resolve::scopes()` indices a phone is in: light and dark under the
/// `width <= 640px` / coarse-pointer overrides, with the translucent material.
const SCOPES: [(&str, usize); 2] = [("light", 4), ("dark", 5)];

/// Rust field names that have a React Native key; other fields keep their names.
const KEYS: [(&str, &str); 5] = [
    ("x", "offsetX"),
    ("y", "offsetY"),
    ("blur", "blurRadius"),
    ("spread", "spreadDistance"),
    ("angle_deg", "angleDeg"),
];

pub(crate) fn generate(blocks: &[Block]) -> Result<String, String> {
    let values = resolve::scopes()
        .iter()
        .map(|s| resolve::resolve(blocks, *s))
        .collect::<Result<Vec<_>, _>>()?;
    let themes = SCOPES
        .iter()
        .map(|(theme, scope)| {
            let mut kinds: BTreeMap<_, Vec<String>> = BTreeMap::new();
            for (name, value) in &values[*scope] {
                let kind = output::classify(name, &values)?;
                let code = output::value_code(Some(value), kind, false)?;
                if let Some(json) = render(&code).map_err(|e| format!("{name}: {e}"))? {
                    kinds
                        .entry(kind)
                        .or_default()
                        .push(format!("      {name:?}: {json}"));
                }
            }
            let kinds = kinds
                .iter()
                .map(|(kind, tokens)| {
                    format!("    {:?}: {{\n{}\n    }}", kind.name(), tokens.join(",\n"))
                })
                .collect::<Vec<_>>();
            Ok(format!("  {theme:?}: {{\n{}\n  }}", kinds.join(",\n")))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!("{{\n{}\n}}\n", themes.join(",\n")))
}

/// One Rust initializer as JSON. `None` when it is not a static literal: a
/// viewport expression, a reference to another token or a non-finite number.
fn render(code: &str) -> Result<Option<String>, String> {
    let mut reader = Reader { text: code, pos: 0 };
    let json = reader.value()?;
    if reader.pos == code.len() {
        Ok(json)
    } else {
        Err(format!("unread {}", &code[reader.pos..]))
    }
}

fn channel(value: &str) -> Result<f64, String> {
    value
        .parse::<f64>()
        .map(|c| (c * 255.).round())
        .map_err(|e| e.to_string())
}

struct Reader<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Reader<'a> {
    /// Skip whitespace, then consume `token` if it is next.
    fn eat(&mut self, token: &str) -> bool {
        let rest = &self.text[self.pos..];
        self.pos += rest.len() - rest.trim_start().len();
        let found = self.text[self.pos..].starts_with(token);
        if found {
            self.pos += token.len();
        }
        found
    }

    /// A number, path or field name: `0.980_392_16`, `Len::Px`, `angle_deg`.
    fn word(&mut self) -> &'a str {
        self.eat("");
        let text = self.text;
        let rest = &text[self.pos..];
        let mut end = 0;
        loop {
            let tail = &rest[end..];
            if tail.starts_with("::") {
                end += 2;
            } else if tail.starts_with(|c: char| c.is_ascii_alphanumeric() || "_.-+".contains(c)) {
                end += 1;
            } else {
                break;
            }
        }
        self.pos += end;
        &rest[..end]
    }

    fn items(&mut self, close: &str) -> Result<Option<Vec<String>>, String> {
        let mut items = Vec::new();
        while !self.eat(close) {
            items.push(self.value()?);
            self.eat(",");
        }
        Ok(items.into_iter().collect())
    }

    fn value(&mut self) -> Result<Option<String>, String> {
        self.eat("&");
        for (open, close) in [("[", "]"), ("(", ")")] {
            if self.eat(open) {
                let items = self.items(close)?;
                return Ok(items.map(|items| format!("[{}]", items.join(", "))));
            }
        }
        if self.eat("\"") {
            let rest = &self.text[self.pos..];
            let end = rest
                .find('"')
                .filter(|end| !rest[..*end].contains('\\'))
                .ok_or("unsupported string")?;
            self.pos += end + 1;
            return Ok(Some(format!("\"{}\"", &rest[..end])));
        }
        let word = self.word();
        if word.starts_with(|c: char| c == '-' || c.is_ascii_digit()) {
            let n = word
                .replace('_', "")
                .parse::<f32>()
                .map_err(|e| format!("{word}: {e}"))?;
            return Ok(Some(n.to_string()));
        }
        if self.eat("(") {
            return self.call(word);
        }
        if self.eat("{") {
            return self.fields(word);
        }
        match word {
            "" => Err(format!("unexpected {}", &self.text[self.pos..])),
            "true" | "false" => Ok(Some(word.into())),
            _ => Ok(None),
        }
    }

    /// `Len::Px(8.0)` is its value; any other variant is `{"variant": value}`.
    fn call(&mut self, name: &str) -> Result<Option<String>, String> {
        let Some(args) = self.items(")")? else {
            return Ok(None);
        };
        let [arg] = args.as_slice() else {
            return Err(format!("{name} takes one value"));
        };
        let variant = name
            .rsplit("::")
            .next()
            .unwrap_or(name)
            .to_ascii_lowercase();
        Ok(match name {
            "Len::Expr" => None,
            "Len::Px" | "Len::Scaled" | "Keyword" => Some(arg.clone()),
            _ => Some(format!("{{{variant:?}: {arg}}}")),
        })
    }

    /// `Rgba` is a colour string; any other struct is an object of its fields.
    fn fields(&mut self, name: &str) -> Result<Option<String>, String> {
        let mut fields = Vec::new();
        while !self.eat("}") {
            let key = self.word();
            if !self.eat(":") {
                return Err(format!("{name}: malformed field {key}"));
            }
            fields.push(self.value()?.map(|value| (key, value)));
            self.eat(",");
        }
        let Some(fields) = fields.into_iter().collect::<Option<Vec<_>>>() else {
            return Ok(None);
        };
        if name == "Rgba"
            && let [(_, r), (_, g), (_, b), (_, a)] = fields.as_slice()
        {
            return Ok(Some(format!(
                "\"rgba({}, {}, {}, {a})\"",
                channel(r)?,
                channel(g)?,
                channel(b)?
            )));
        }
        let members = fields
            .iter()
            .map(|(key, value)| {
                let key = KEYS
                    .iter()
                    .find(|(rust, _)| rust == key)
                    .map_or(*key, |(_, native)| *native);
                format!("{key:?}: {value}")
            })
            .collect::<Vec<_>>();
        Ok(Some(format!("{{{}}}", members.join(", "))))
    }
}

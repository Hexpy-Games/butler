//! Resolve each theme/material/override scope after applying its declarations.
use crate::css::{Block, Declaration, closing, split};
use crate::value::{Kind, Value};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Scope {
    pub index: usize,
    pub compact: bool,
    pub density: Option<usize>,
    pub reduced: bool,
}

pub(crate) fn scopes() -> Vec<Scope> {
    let mut scopes = Vec::new();
    for compact in [false, true] {
        for index in 0..4 {
            scopes.push(Scope {
                index,
                compact,
                density: None,
                reduced: false,
            });
        }
    }
    for reduced in [false, true] {
        for index in 0..4 {
            for compact in [false, true] {
                for density in 0..3 {
                    scopes.push(Scope {
                        index,
                        compact,
                        density: Some(density),
                        reduced,
                    });
                }
            }
        }
    }
    scopes
}

pub(crate) fn declarations(blocks: &[Block], scope: Scope) -> BTreeMap<String, Declaration> {
    let mut values: BTreeMap<String, Declaration> = BTreeMap::new();
    for stage in 0..5 {
        let fallback = values.clone();
        for block in blocks {
            let c = &block.condition;
            let block_stage = if c.reduced {
                4
            } else if c.density.is_some() {
                3
            } else if c.compact {
                2
            } else {
                usize::from(c.solid)
            };
            if block_stage != stage
                || c.dark.is_some_and(|dark| dark != (scope.index % 2 == 1))
                || (c.solid && scope.index < 2)
                || (c.compact && !scope.compact)
                || c.density.is_some_and(|d| Some(d) != scope.density)
                || (c.reduced && !scope.reduced)
                || c.explicit_motion
            {
                continue;
            }
            for d in &block.declarations {
                if d.value == "initial" {
                    if let Some(base) = fallback.get(&d.name) {
                        values.insert(d.name.clone(), base.clone());
                    } else {
                        values.remove(&d.name);
                    }
                } else {
                    values.insert(d.name.clone(), d.clone());
                }
            }
        }
    }
    values
}

pub(crate) fn resolve(blocks: &[Block], scope: Scope) -> Result<BTreeMap<String, Value>, String> {
    let declarations = declarations(blocks, scope);
    let mut resolver = Resolver {
        declarations: &declarations,
        cache: BTreeMap::new(),
        visiting: Vec::new(),
    };
    declarations
        .iter()
        .map(|(name, d)| {
            let value = resolver
                .token(name)
                .and_then(|text| {
                    if d.value.trim().starts_with("var(")
                        && d.value.contains('/')
                        && text.contains(',')
                    {
                        shorthand(&d.value)
                    } else {
                        crate::value::parse(&text)
                    }
                })
                .map_err(|e| format!("{name}, scope {scope:?}, line {}: {e}", d.line))?;
            Ok((name.clone(), value))
        })
        .collect()
}

fn shorthand(raw: &str) -> Result<Value, String> {
    let refs = raw
        .split("var(")
        .skip(1)
        .map(|s| s.split(')').next().unwrap_or_default().trim())
        .collect::<Vec<_>>();
    if refs.len() != 3 && refs.len() != 4 {
        return Err(
            "font shorthand requires size/line-height/family and optional weight references".into(),
        );
    }
    let n = refs.len();
    let weight = if n == 4 {
        format!("Some(Number::{})", variant(refs[0]))
    } else {
        "None".into()
    };
    Ok(Value {
        kind: Kind::FontStyle,
        code: format!(
            "FontShorthand {{ size: Length::{}, line_height: Length::{}, weight: {weight}, family: FontStack::{} }}",
            variant(refs[n - 3]),
            variant(refs[n - 2]),
            variant(refs[n - 1])
        ),
    })
}

pub(crate) fn variant(name: &str) -> String {
    name.trim_start_matches("--")
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |c| {
                format!("{}{}", c.to_ascii_uppercase(), chars.as_str())
            })
        })
        .collect()
}

struct Resolver<'a> {
    declarations: &'a BTreeMap<String, Declaration>,
    cache: BTreeMap<String, String>,
    visiting: Vec<String>,
}

impl Resolver<'_> {
    fn token(&mut self, name: &str) -> Result<String, String> {
        if let Some(value) = self.cache.get(name) {
            return Ok(value.clone());
        }
        if self.visiting.iter().any(|v| v == name) {
            return Err(format!(
                "alias cycle: {} -> {name}",
                self.visiting.join(" -> ")
            ));
        }
        let d = self
            .declarations
            .get(name)
            .ok_or_else(|| format!("unknown token {name}"))?;
        self.visiting.push(name.into());
        let value = self.value(&d.value)?;
        self.visiting.pop();
        self.cache.insert(name.into(), value.clone());
        Ok(value)
    }

    fn value(&mut self, text: &str) -> Result<String, String> {
        let mut result = String::new();
        let mut pos = 0;
        while let Some(start) = text[pos..].find("var(").map(|i| i + pos) {
            result.push_str(&text[pos..start]);
            let close = closing(text, start + 3, '(', ')')?;
            let parts = split(&text[start + 4..close], ',');
            let name = parts.first().ok_or("empty var()")?;
            if *name == "--ui-scale" {
                self.token(name)?;
                result.push_str("var(--ui-scale)");
            } else if self.declarations.contains_key(*name) {
                result.push_str(&self.token(name)?);
            } else if parts.len() > 1 {
                result.push_str(&self.value(&parts[1..].join(", "))?);
            } else {
                return Err(format!("unknown token {name}"));
            }
            pos = close + 1;
        }
        result.push_str(&text[pos..]);
        Ok(result)
    }
}

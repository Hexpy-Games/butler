use std::{collections::HashSet, fs, path::PathBuf};

use serde::Serialize;

use crate::public_text::{trim_js_whitespace, trim_js_whitespace_start};

const PRESET_ORDER: [&str; 9] = [
    "butler",
    "guardian",
    "demon-butler",
    "wolf-butler",
    "neko-servant",
    "think-tank",
    "operator",
    "archivist",
    "dry-wit",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PersonaLocale {
    En,
    Ko,
}

impl PersonaLocale {
    fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Ko => "ko",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct PersonaPreset {
    pub name: String,
    pub label: String,
    pub description: String,
    pub preview: String,
    pub locale: PersonaLocale,
    pub content: String,
}

/// Host supplies the program home. No directory watcher or contents cache is
/// retained: an external template edit is visible on the next operation.
pub(crate) struct PersonaPresets {
    resource_root: PathBuf,
}

impl PersonaPresets {
    pub(crate) fn new(resource_root: PathBuf) -> Self {
        Self { resource_root }
    }

    pub(crate) fn list(&self, locale: PersonaLocale) -> Vec<PersonaPreset> {
        let root = self.root();
        let mut names = HashSet::new();
        for candidate in [PersonaLocale::En, locale] {
            let Ok(entries) = fs::read_dir(root.join(candidate.as_str())) else {
                continue;
            };
            for entry in entries.flatten() {
                let filename = entry.file_name().to_string_lossy().into_owned();
                if let Some(name) = filename.strip_suffix(".md") {
                    names.insert(name.to_owned());
                }
            }
        }
        let mut ordered = PRESET_ORDER
            .iter()
            .filter(|name| names.contains(**name))
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>();
        let mut extra = names
            .into_iter()
            .filter(|name| !PRESET_ORDER.contains(&name.as_str()))
            .collect::<Vec<_>>();
        extra.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        ordered.extend(extra);
        ordered
            .into_iter()
            .filter_map(|name| self.read(locale, &name))
            .collect()
    }

    pub(crate) fn read(&self, locale: PersonaLocale, name: &str) -> Option<PersonaPreset> {
        let name = safe_persona_preset_name(name)?;
        let root = self.root();
        let candidates: &[PersonaLocale] = match locale {
            PersonaLocale::En => &[PersonaLocale::En],
            PersonaLocale::Ko => &[PersonaLocale::Ko, PersonaLocale::En],
        };
        // A validated ASCII basename cannot introduce a separator or parent
        // component. As in the source, symlinks are followed by the file read.
        for &candidate in candidates {
            let path = root.join(candidate.as_str()).join(format!("{name}.md"));
            let Ok(bytes) = fs::read(path) else { continue };
            let raw = String::from_utf8_lossy(&bytes);
            let (frontmatter, body) = parse_frontmatter(&raw);
            return Some(PersonaPreset {
                name: name.to_owned(),
                label: label(frontmatter.get("name").map(String::as_str).unwrap_or(name)),
                description: frontmatter.get("description").cloned().unwrap_or_default(),
                preview: frontmatter.get("preview").cloned().unwrap_or_default(),
                locale: candidate,
                content: format!(
                    "---\nname: active\nbase: {name}\nbase_locale: {}\n---\n\n{}\n",
                    candidate.as_str(),
                    trim_js_whitespace(body),
                ),
            });
        }
        None
    }

    fn root(&self) -> PathBuf {
        self.resource_root.join("personas/templates")
    }
}

pub(crate) fn safe_persona_preset_name(value: &str) -> Option<&str> {
    let value = trim_js_whitespace(value);
    let mut bytes = value.bytes();
    let first = bytes.next()?;
    (value.len() <= 96
        && first.is_ascii_alphanumeric()
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))
    .then_some(value)
}

fn parse_frontmatter(text: &str) -> (std::collections::HashMap<String, String>, &str) {
    let mut fields = std::collections::HashMap::new();
    let Some(rest) = text.strip_prefix("---\n") else {
        return (fields, trim_js_whitespace_start(text));
    };
    let Some(end) = rest.find("\n---") else {
        return (fields, trim_js_whitespace_start(text));
    };
    for line in rest[..end].split('\n') {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            continue;
        }
        // JS dot excludes CR, LF, U+2028 and U+2029. The preceding \s*
        // consumes leading whitespace before that capture.
        let value = trim_js_whitespace_start(value);
        if value.contains(['\r', '\n', '\u{2028}', '\u{2029}']) {
            continue;
        }
        let value = trim_js_whitespace(value);
        let value = value.strip_prefix('"').unwrap_or(value);
        let value = value.strip_suffix('"').unwrap_or(value);
        fields.insert(key.to_owned(), value.to_owned());
    }
    let body = &rest[end + 4..];
    let body = body.strip_prefix('\n').unwrap_or(body);
    (fields, trim_js_whitespace_start(body))
}

fn label(name: &str) -> String {
    name.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let Some(first) = part.chars().next() else {
                return String::new();
            };
            // Source uppercases slice(0,1), a single UTF-16 unit. A leading
            // supplementary character is therefore unchanged, even if cased.
            if first.len_utf16() == 2 {
                return part.to_owned();
            }
            format!("{}{}", first.to_uppercase(), &part[first.len_utf8()..])
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests;

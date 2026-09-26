use std::{collections::HashSet, fs, path::Path, sync::OnceLock};

use regex::{Regex, RegexBuilder};
use serde_json::Value;

use crate::cognition::mutable_paths::ensure_data_authority;

const KNOWN_TOOLS: &[&str] = &[
    "LanceDB",
    "SQLite",
    "ChromaDB",
    "NetworkX",
    "Discord",
    "bge-m3",
    "OpenAI",
    "Bun",
    "Node",
    "TypeScript",
    "Python",
    "MCP",
    "LLM",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ExtractedEntity {
    pub(super) kind: &'static str,
    pub(super) name: String,
    pub(super) project: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ExtractedEdge {
    pub(super) source_type: &'static str,
    pub(super) source_name: String,
    pub(super) target_type: &'static str,
    pub(super) target_name: String,
    pub(super) relation: &'static str,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ExtractionResult {
    pub(super) entities: Vec<ExtractedEntity>,
    pub(super) edges: Vec<ExtractedEdge>,
}

pub(super) fn extract(
    data_root: &Path,
    text: &str,
    project: &str,
) -> Result<ExtractionResult, String> {
    let projects = known_projects(data_root)?;
    let mut result = ExtractionResult::default();
    let mut seen = HashSet::new();

    for known in &projects {
        if contains_catalog_token(text, known) {
            add_entity(&mut result, &mut seen, "project", known, None);
        }
    }
    let project = (!project.is_empty()).then_some(project);
    if let Some(project) = project {
        add_entity(&mut result, &mut seen, "project", project, None);
    }
    for tool in KNOWN_TOOLS {
        if contains_catalog_token(text, tool) {
            add_entity(&mut result, &mut seen, "tool", tool, project);
        }
    }

    if has_decision(text) {
        let summary = prefix_utf16(text, 80).replace('\n', " ");
        let summary = crate::public_text::trim_js_whitespace(&summary).to_owned();
        add_entity(&mut result, &mut seen, "decision", &summary, project);
        if let Some(project) = project {
            result.edges.push(ExtractedEdge {
                source_type: "project",
                source_name: project.to_owned(),
                target_type: "decision",
                target_name: summary,
                relation: "decided",
            });
        }
    }

    for expression in concept_patterns() {
        for captures in expression.captures_iter(text) {
            let Some(captured) = captures.get(1) else {
                continue;
            };
            let name = crate::public_text::trim_js_whitespace(captured.as_str());
            let length = name.encode_utf16().count();
            if (2..=40).contains(&length) {
                add_entity(&mut result, &mut seen, "concept", name, project);
            }
        }
    }

    if has_interest(text)
        && let Some(project) = project
    {
        result.edges.push(ExtractedEdge {
            source_type: "project",
            source_name: project.to_owned(),
            target_type: "concept",
            target_name: "learning".to_owned(),
            relation: "interested_in",
        });
        add_entity(&mut result, &mut seen, "concept", "learning", Some(project));
    }

    let project_names = result
        .entities
        .iter()
        .filter(|entity| entity.kind == "project")
        .map(|entity| entity.name.clone())
        .collect::<Vec<_>>();
    let tool_names = result
        .entities
        .iter()
        .filter(|entity| entity.kind == "tool")
        .map(|entity| entity.name.clone())
        .collect::<Vec<_>>();
    for project_name in project_names {
        for tool_name in &tool_names {
            result.edges.push(ExtractedEdge {
                source_type: "project",
                source_name: project_name.clone(),
                target_type: "tool",
                target_name: tool_name.clone(),
                relation: "works_on",
            });
        }
    }
    Ok(result)
}

pub(super) fn mention_snippet(text: &str) -> String {
    let prefix = prefix_utf16(text, 200).replace('\n', " ");
    crate::public_text::trim_js_whitespace(&prefix).to_owned()
}

fn known_projects(data_root: &Path) -> Result<Vec<String>, String> {
    let path = data_root.join("butler.config.json");
    ensure_data_authority(data_root, &[&path]).map_err(|failure| failure.code.to_owned())?;
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return Ok(Vec::new());
    };
    let projects = match config.get("projects") {
        Some(Value::Array(projects)) => projects.iter().collect::<Vec<_>>(),
        Some(Value::Object(projects)) => projects.values().collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    Ok(projects
        .into_iter()
        .filter_map(|project| project.get("name").and_then(Value::as_str))
        .filter(|name| name.encode_utf16().count() > 1)
        .map(str::to_owned)
        .collect())
}

fn add_entity(
    result: &mut ExtractionResult,
    seen: &mut HashSet<String>,
    kind: &'static str,
    name: &str,
    owner: Option<&str>,
) {
    if seen.insert(format!("{kind}|{name}")) {
        result.entities.push(ExtractedEntity {
            kind,
            name: name.to_owned(),
            project: owner.map(str::to_owned),
        });
    }
}

fn contains_catalog_token(text: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    for (start, _) in text.char_indices() {
        let end = if token.is_ascii() {
            start.checked_add(token.len())
        } else {
            let remaining = &text[start..];
            remaining
                .char_indices()
                .nth(token.chars().count())
                .map(|(offset, _)| start + offset)
                .or_else(|| {
                    (remaining.chars().count() == token.chars().count()).then_some(text.len())
                })
        };
        let Some(end) = end else {
            continue;
        };
        if end > text.len() || !text.is_char_boundary(end) {
            continue;
        }
        let matches = if token.is_ascii() {
            text[start..end].eq_ignore_ascii_case(token)
        } else {
            text[start..end].to_lowercase() == token.to_lowercase()
        };
        if !matches {
            continue;
        }
        let before_is_word = text[..start]
            .chars()
            .next_back()
            .is_some_and(is_source_word);
        let after_is_word = text[end..].chars().next().is_some_and(is_source_word);
        if !before_is_word && !after_is_word {
            return true;
        }
    }
    false
}

fn is_source_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn has_decision(text: &str) -> bool {
    static ENGLISH: OnceLock<Regex> = OnceLock::new();
    static KOREAN: OnceLock<Regex> = OnceLock::new();
    static ARROW: OnceLock<Regex> = OnceLock::new();
    ENGLISH
        .get_or_init(|| {
            RegexBuilder::new(r"decided|chose|went with|switched to")
                .case_insensitive(true)
                .build()
                .unwrap()
        })
        .is_match(text)
        || KOREAN
            .get_or_init(|| Regex::new(r"결정|채택|선택|대신").unwrap())
            .is_match(text)
        || ARROW
            .get_or_init(|| Regex::new(r"→\s*[A-Za-z0-9_]").unwrap())
            .is_match(text)
}

fn concept_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            RegexBuilder::new(r"([A-Za-z0-9_]+)\s+is\s+a\s+(.{5,60})")
                .case_insensitive(true)
                .build()
                .unwrap(),
            RegexBuilder::new(r"([A-Za-z0-9_]+)\s+means\s+(.{5,60})")
                .case_insensitive(true)
                .build()
                .unwrap(),
            Regex::new(r"([A-Za-z0-9_]+)이란\s+(.{5,60})").unwrap(),
            Regex::new(r"([A-Za-z0-9_]+)란\s+(.{5,60})").unwrap(),
        ]
        .to_vec()
    })
}

fn has_interest(text: &str) -> bool {
    static ENGLISH: OnceLock<Regex> = OnceLock::new();
    static KOREAN: OnceLock<Regex> = OnceLock::new();
    ENGLISH
        .get_or_init(|| {
            RegexBuilder::new(r"curious about|learning|interested in")
                .case_insensitive(true)
                .build()
                .unwrap()
        })
        .is_match(text)
        || KOREAN
            .get_or_init(|| Regex::new(r"궁금|배우|공부|관심").unwrap())
            .is_match(text)
}

fn prefix_utf16(text: &str, limit: usize) -> String {
    let units = text.encode_utf16().take(limit).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "butler-hot-cache-rules-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn extracts_catalog_tools_decisions_concepts_and_interest_in_source_order() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("butler.config.json"),
            r#"{"projects":[{"name":"alpha_service"},{"name":"x"}]}"#,
        )
        .unwrap();
        let extracted = extract(
            &root,
            "alpha_service uses SQLite. We decided this. Cache is a useful local memory layer and I am curious about learning.",
            "alpha_service",
        )
        .unwrap();
        let names = extracted
            .entities
            .iter()
            .map(|entity| (entity.kind, entity.name.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                ("project", "alpha_service"),
                ("tool", "SQLite"),
                (
                    "decision",
                    "alpha_service uses SQLite. We decided this. Cache is a useful local memory layer",
                ),
                ("concept", "Cache"),
                ("concept", "learning"),
            ]
        );
        assert_eq!(extracted.edges[0].relation, "decided");
        assert_eq!(extracted.edges[1].relation, "interested_in");
        assert_eq!(extracted.edges[2].relation, "works_on");
        let _ = fs::remove_dir_all(root);
    }
}

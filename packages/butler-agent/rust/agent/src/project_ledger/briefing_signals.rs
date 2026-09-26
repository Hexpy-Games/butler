//! Bounded, non-mutating Project Ledger summaries for New Chat Briefing.

use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{ProjectLedgerReadError, active_reference};
use crate::locale::LocaleCollation;

#[derive(Clone, Debug)]
pub(crate) struct ProjectBriefingTarget {
    pub id: String,
    pub display_name: String,
    pub ledger_project_id: String,
    pub recent_session_titles: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectBriefingSignal {
    pub id: String,
    pub display_name: String,
    pub summary: Option<String>,
    pub recent_session_titles: Vec<String>,
    pub ledger_event_summary: Vec<String>,
    pub open_work_titles: Vec<String>,
    pub completed_work_titles: Vec<String>,
    pub excluded_topics: Vec<String>,
}

pub(super) fn read(
    root: &Path,
    collation: &LocaleCollation,
    targets: Option<&[ProjectBriefingTarget]>,
    consolidation_root: &Path,
) -> Result<Vec<ProjectBriefingSignal>, ProjectLedgerReadError> {
    let is_app_scoped = targets.is_some();
    let targets = match targets {
        Some(targets) => targets.to_vec(),
        None => read_ledger_targets(root)?,
    };
    let mut seen = HashSet::new();
    let mut signals = Vec::with_capacity(targets.len());
    for target in targets {
        if !seen.insert(target.id.clone()) {
            continue;
        }
        signals.push(read_project(root, consolidation_root, target)?);
    }
    if !is_app_scoped {
        signals.sort_by(|left, right| collation.compare(&left.display_name, &right.display_name));
    }
    Ok(signals)
}

fn read_ledger_targets(root: &Path) -> Result<Vec<ProjectBriefingTarget>, ProjectLedgerReadError> {
    let projects = root.join("project-ledger/projects");
    let entries = match fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => {
            return Err(ProjectLedgerReadError::Owner(
                "project_ledger_briefing_read_failed",
            ));
        }
    };
    let mut targets = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|_| ProjectLedgerReadError::Owner("project_ledger_briefing_read_failed"))?;
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(directory_id) = entry.file_name().into_string().ok() else {
            continue;
        };
        let metadata = read_json(&entry.path().join("project.json"));
        let id = metadata
            .as_ref()
            .and_then(|value| value["id"].as_str())
            .filter(|id| !id.is_empty())
            .unwrap_or(&directory_id);
        // Ledger project IDs are path identities. Never sanitize a bad ID into
        // a different directory or read a neighboring project's records.
        if !active_reference::safe_id(id) || id != directory_id.as_str() {
            continue;
        }
        let display_name = metadata
            .as_ref()
            .and_then(|value| value["name"].as_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(id);
        targets.push(ProjectBriefingTarget {
            id: id.to_owned(),
            display_name: display_name.to_owned(),
            ledger_project_id: id.to_owned(),
            recent_session_titles: vec![],
        });
    }
    Ok(targets)
}

fn read_project(
    root: &Path,
    consolidation_root: &Path,
    target: ProjectBriefingTarget,
) -> Result<ProjectBriefingSignal, ProjectLedgerReadError> {
    let ledger_id = target.ledger_project_id.as_str();
    let project_root = if active_reference::safe_id(ledger_id) {
        root.join("project-ledger/projects").join(ledger_id)
    } else {
        PathBuf::new()
    };
    let metadata = (!project_root.as_os_str().is_empty())
        .then(|| read_json(&project_root.join("project.json")))
        .flatten();
    let metadata_id = metadata
        .as_ref()
        .and_then(|value| value["id"].as_str())
        .filter(|id| !id.is_empty());
    let ledger_matches = metadata_id.is_none_or(|id| id == ledger_id);
    let project_root = if ledger_matches {
        project_root
    } else {
        PathBuf::new()
    };
    let summary = if ledger_matches {
        metadata
            .as_ref()
            .and_then(|value| value["summary"].as_str())
            .map(normalize_text)
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let ledger_event_summary = if ledger_matches && !project_root.as_os_str().is_empty() {
        event_summary(&project_root.join("ledger.jsonl"))?
    } else {
        vec![]
    };
    let (open_work_titles, completed_work_titles) =
        if ledger_matches && !project_root.as_os_str().is_empty() {
            work_titles(&project_root)?
        } else {
            (vec![], vec![])
        };
    Ok(ProjectBriefingSignal {
        id: target.id.clone(),
        display_name: target.display_name,
        summary,
        recent_session_titles: unique_strings(target.recent_session_titles, 8),
        ledger_event_summary,
        open_work_titles,
        completed_work_titles,
        excluded_topics: excluded_topics(consolidation_root, &target.id),
    })
}

fn read_json(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    serde_json::from_reader(file).ok()
}

fn event_summary(path: &Path) -> Result<Vec<String>, ProjectLedgerReadError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => {
            return Err(ProjectLedgerReadError::Owner(
                "project_ledger_briefing_read_failed",
            ));
        }
    };
    let mut lines = VecDeque::with_capacity(80);
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| ProjectLedgerReadError::Owner("project_ledger_briefing_read_failed"))?;
        if read == 0 {
            break;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
            let parts = ["type", "kind", "status"]
                .iter()
                .filter_map(|key| value[*key].as_str())
                .collect::<Vec<_>>();
            if value["type"].is_string() {
                if lines.len() == 80 {
                    lines.pop_front();
                }
                lines.push_back(parts.join(":"));
            } else if !line.iter().all(u8::is_ascii_whitespace) {
                if lines.len() == 80 {
                    lines.pop_front();
                }
                lines.push_back(String::new());
            }
        } else if !line.iter().all(u8::is_ascii_whitespace) {
            if lines.len() == 80 {
                lines.pop_front();
            }
            lines.push_back(String::new());
        }
    }
    let mut counts = Vec::<(String, usize)>::new();
    for line in lines.into_iter().filter(|line| !line.is_empty()) {
        if let Some((_, count)) = counts.iter_mut().find(|(key, _)| key == &line) {
            *count += 1;
        } else {
            counts.push((line, 1));
        }
    }
    counts.sort_by(|left, right| right.1.cmp(&left.1));
    Ok(counts
        .into_iter()
        .take(12)
        .map(|(key, count)| format!("{key} x{count}"))
        .collect())
}

fn work_titles(project_root: &Path) -> Result<(Vec<String>, Vec<String>), ProjectLedgerReadError> {
    let root = project_root.join("work");
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((vec![], vec![]));
        }
        Err(_) => {
            return Err(ProjectLedgerReadError::Owner(
                "project_ledger_briefing_read_failed",
            ));
        }
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|_| ProjectLedgerReadError::Owner("project_ledger_briefing_read_failed"))?;
        if !entry.file_type().is_ok_and(|kind| kind.is_dir())
            || entry
                .file_name()
                .to_string_lossy()
                .starts_with("guided-work-")
        {
            continue;
        }
        let path = entry.path().join("work.md");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => continue,
        };
        let frontmatter = text.split("\n---\n").next().unwrap_or("");
        let title = frontmatter_field(frontmatter, "title")
            .map(|value| crate::public_text::sanitize_public_text(&value, ""))
            .unwrap_or_default();
        let status = frontmatter_field(frontmatter, "status").unwrap_or_default();
        if title.is_empty()
            || !matches!(
                status.as_str(),
                "done" | "in_progress" | "blocked" | "review"
            )
        {
            continue;
        }
        let updated_at = frontmatter_field(frontmatter, "updatedAt").unwrap_or_default();
        records.push((
            title.chars().take(180).collect::<String>(),
            status,
            updated_at,
        ));
    }
    records.sort_by(|left, right| right.2.cmp(&left.2));
    let open = unique_strings(
        records
            .iter()
            .filter(|(_, status, _)| status != "done")
            .map(|(title, _, _)| title.clone())
            .collect(),
        12,
    );
    let completed = unique_strings(
        records
            .into_iter()
            .filter(|(_, status, _)| status == "done")
            .map(|(title, _, _)| title)
            .collect(),
        30,
    );
    Ok((open, completed))
}

fn frontmatter_field(frontmatter: &str, field: &str) -> Option<String> {
    let prefix = format!("{field}:");
    let value = frontmatter
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))?
        .trim();
    if value.starts_with('"') {
        serde_json::from_str::<String>(value).ok()
    } else if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

fn excluded_topics(consolidation_root: &Path, project_id: &str) -> Vec<String> {
    let Some(policy) = read_json(&consolidation_root.join("briefing-exclusions.json")) else {
        return vec![];
    };
    let Some(values) = policy["projects"][project_id].as_array() else {
        return vec![];
    };
    unique_strings(
        values
            .iter()
            .filter_map(Value::as_str)
            .map(|value| value.trim().chars().take(80).collect())
            .collect(),
        20,
    )
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn unique_strings(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests;

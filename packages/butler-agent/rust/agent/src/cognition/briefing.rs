//! Read-only access to the durable New Chat Briefing artifact contract.

mod generation;
pub(crate) use generation::{
    BriefingGenerationError, BriefingGenerationService, BriefingInputFuture, BriefingInputSnapshot,
    BriefingInputSource, BriefingPersona, BriefingProjectSignal, BriefingSettings,
};

use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(crate) fn read_new_chat_briefing(
    data_root: &Path,
    date: Option<&str>,
    scope: &str,
    project_id: Option<&str>,
    locale: &str,
) -> Option<Value> {
    let root = data_root.join("cognition/consolidation/briefings");
    let dates = if let Some(date) = date.map(str::trim).filter(|date| !date.is_empty()) {
        if !valid_date(date) {
            return None;
        }
        vec![date.to_owned()]
    } else {
        Vec::new()
    };
    let mut before: Option<String> = None;
    loop {
        let batch = if dates.is_empty() {
            latest_date_batch(&root, before.as_deref())?
        } else {
            dates.clone()
        };
        if batch.is_empty() {
            return None;
        }
        let oldest = batch.last().cloned();
        for date in batch {
            let path = artifact_path(&root, &date, scope, project_id)?;
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if valid_artifact(&value, scope, project_id, locale) {
                return Some(value);
            }
        }
        if !dates.is_empty() {
            return None;
        }
        before = oldest;
    }
}

fn latest_date_batch(root: &Path, before: Option<&str>) -> Option<Vec<String>> {
    let mut dates = BTreeSet::new();
    for entry in fs::read_dir(root).ok()?.filter_map(Result::ok) {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(name) =
            entry.file_name().into_string().ok().filter(|name| {
                valid_date(name) && before.is_none_or(|before| name.as_str() < before)
            })
        else {
            continue;
        };
        dates.insert(name);
        if dates.len() > 64 {
            dates.pop_first();
        }
    }
    Some(dates.into_iter().rev().collect())
}

fn artifact_path(
    root: &Path,
    date: &str,
    scope: &str,
    project_id: Option<&str>,
) -> Option<PathBuf> {
    match scope {
        "general" => Some(root.join(date).join("general.json")),
        "project" => {
            let id = project_id?;
            let mut segment = id
                .trim()
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            while segment.contains("__") {
                segment = segment.replace("__", "_");
            }
            if segment.is_empty() {
                segment = "project".into();
            }
            Some(
                root.join(date)
                    .join("projects")
                    .join(format!("{segment}.json")),
            )
        }
        _ => None,
    }
}

fn valid_date(date: &str) -> bool {
    date.len() == 10
        && date.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

fn valid_artifact(value: &Value, scope: &str, project_id: Option<&str>, locale: &str) -> bool {
    value["schema"] == "butler.cognition.new-chat-briefing.v1"
        && value["scope"] == scope
        && value["locale"] == locale
        && (scope != "project" || value["project_id"] == project_id.unwrap_or_default())
        && value["title"].as_str().is_some_and(|text| !text.is_empty())
        && value["description"].is_string()
        && value["source"]["raw_text_included"] == false
        && value["raw_text_included"] == false
        && value["suggestions"]
            .as_array()
            .is_some_and(|items| items.len() >= 4)
        && value.get("title_variants").is_none_or(|variants| {
            ["morning", "afternoon", "evening", "night"]
                .iter()
                .all(|key| variants[*key].as_str().is_some_and(|text| !text.is_empty()))
        })
}

pub(crate) fn latest_completed_briefing_run_id(
    data_root: &Path,
    date: Option<&str>,
) -> Option<String> {
    let mut best: Option<(SystemTime, String)> = None;
    for entry in fs::read_dir(data_root.join("cognition/consolidation/runs"))
        .ok()?
        .filter_map(Result::ok)
    {
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Some(modified) = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
        else {
            continue;
        };
        if best.as_ref().is_some_and(|(time, _)| modified <= *time) {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if value["status"] != "completed" {
            continue;
        }
        if date.filter(|date| !date.is_empty()).is_some_and(|date| {
            !["completed_at", "started_at"].iter().any(|key| {
                value[*key]
                    .as_str()
                    .and_then(|timestamp| timestamp.get(..10))
                    .filter(|part| valid_date(part))
                    == Some(date)
            })
        }) {
            continue;
        }
        if let Some(id) = value["run_id"].as_str() {
            best = Some((modified, id.to_owned()));
        }
    }
    best.map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_existing_valid_artifact_and_rejects_wrong_scope() {
        let root =
            std::env::temp_dir().join(format!("butler-briefing-reader-{}", uuid::Uuid::new_v4()));
        let day = root.join("cognition/consolidation/briefings/2026-09-23");
        fs::create_dir_all(&day).unwrap();
        let artifact = json!({
            "schema":"butler.cognition.new-chat-briefing.v1", "scope":"general", "project_id":null,
            "locale":"en", "moment":"Morning", "title":"Welcome", "description":"Today",
            "title_variants":{"morning":"Good morning", "afternoon":"Good afternoon", "evening":"Good evening", "night":"Good night"},
            "suggestions":[
                {"id":"one","title":"One","description":"One","text":"One"},
                {"id":"two","title":"Two","description":"Two","text":"Two"},
                {"id":"three","title":"Three","description":"Three","text":"Three"},
                {"id":"four","title":"Four","description":"Four","text":"Four"}
            ],
            "source":{"consolidation_run_id":"cr_test", "generated_at":"2026-09-23T00:00:00.000Z", "raw_text_included":false},
            "raw_text_included":false
        });
        fs::write(
            day.join("general.json"),
            serde_json::to_vec(&artifact).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_new_chat_briefing(&root, None, "general", None, "en"),
            Some(artifact)
        );
        assert!(read_new_chat_briefing(&root, None, "project", Some("p"), "en").is_none());
        assert!(read_new_chat_briefing(&root, Some("../escape"), "general", None, "en").is_none());
        assert!(
            read_new_chat_briefing(&root, Some(" 2026-09-23 "), "general", None, "en").is_some()
        );
        for index in 1..=65 {
            fs::create_dir_all(root.join(format!(
                "cognition/consolidation/briefings/2026-10-{index:02}"
            )))
            .unwrap();
        }
        assert!(read_new_chat_briefing(&root, None, "general", None, "en").is_some());
        let runs = root.join("cognition/consolidation/runs");
        fs::create_dir_all(&runs).unwrap();
        fs::write(
            runs.join("old.json"),
            r#"{"status":"completed","run_id":"cr_old","started_at":"2026-09-23T00:00:00.000Z"}"#,
        )
        .unwrap();
        for index in 1..=65 {
            fs::write(
                runs.join(format!("new-{index:02}.json")),
                r#"{"status":"completed_with_errors","run_id":"cr_failed"}"#,
            )
            .unwrap();
        }
        assert_eq!(
            latest_completed_briefing_run_id(&root, None).as_deref(),
            Some("cr_old")
        );
        assert_eq!(
            latest_completed_briefing_run_id(&root, Some("2026-09-23")).as_deref(),
            Some("cr_old")
        );
        assert!(latest_completed_briefing_run_id(&root, Some("2026")).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}

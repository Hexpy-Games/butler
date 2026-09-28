//! Read-only access to the durable New Chat Briefing artifact contract.

mod generation;
pub use generation::{
    BriefingGenerationCode, BriefingGenerationError, BriefingGenerationService,
    BriefingInputFuture, BriefingInputSnapshot, BriefingInputSource, BriefingPersona,
    BriefingProjectSignal, BriefingSettings,
};

mod stored;
pub use stored::{
    BriefingScope, BriefingSource, BriefingSuggestion, BriefingTitleVariants, NewChatBriefing,
};

use crate::lenient::{self, Obj};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// The newest stored briefing for `scope` (and project) in `locale`, on
/// `date` or the latest day that has one.
pub fn read_new_chat_briefing(
    data_root: &Path,
    date: Option<&str>,
    scope: BriefingScope,
    project_id: Option<&str>,
    locale: &str,
) -> Option<NewChatBriefing> {
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
            let Ok(Obj(stored)) = serde_json::from_slice::<Obj<stored::StoredBriefing>>(&bytes)
            else {
                continue;
            };
            if let Some(briefing) = stored.checked(scope, project_id, locale) {
                return Some(briefing);
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
    scope: BriefingScope,
    project_id: Option<&str>,
) -> Option<PathBuf> {
    match scope {
        BriefingScope::General => Some(root.join(date).join("general.json")),
        BriefingScope::Project => {
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

/// The id of the latest completed consolidation run (on `date`, when given).
pub fn latest_completed_briefing_run_id(data_root: &Path, date: Option<&str>) -> Option<String> {
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
        let Ok(Obj(run)) = serde_json::from_slice::<Obj<RunRecord>>(&bytes) else {
            continue;
        };
        if run.status.as_deref() != Some("completed") {
            continue;
        }
        if date.filter(|date| !date.is_empty()).is_some_and(|date| {
            ![&run.completed_at, &run.started_at]
                .iter()
                .any(|timestamp| {
                    timestamp
                        .as_deref()
                        .and_then(|timestamp| timestamp.get(..10))
                        .filter(|part| valid_date(part))
                        == Some(date)
                })
        }) {
            continue;
        }
        if let Some(id) = run.run_id {
            best = Some((modified, id));
        }
    }
    best.map(|(_, id)| id)
}

/// The fields of a consolidation run record the briefing fallback reads; a
/// field of another type reads as absent.
#[derive(Deserialize)]
struct RunRecord {
    #[serde(default, deserialize_with = "lenient::option")]
    status: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    run_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    completed_at: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    started_at: Option<String>,
}

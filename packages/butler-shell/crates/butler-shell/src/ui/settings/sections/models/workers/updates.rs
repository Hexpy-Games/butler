//! Worker profile data and its edits (`workerProfileUpdates.ts`, `workerProfileTextPatch.ts`).
//! Profiles stay raw JSON objects so a save sends back every field the agent sent.
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ui::composer::menus::ModelChoice;
use crate::ui::composer::menus::model::model_choice;
use crate::ui::composer::queue::effort_wire;
use crate::ui::source::wire::ReasoningEffort;

/// `WORKER_PROFILE_BUILTIN_JOBS`
pub(super) const BUILTIN_JOBS: [&str; 5] = ["coding", "research", "debug", "review", "writing"];
/// `WORKER_PROFILES_LIMIT`
pub(super) const LIMIT: usize = 12;
/// `SIMULTANEOUS_WORKERS_MIN`
const WORKERS_MIN: u32 = 1;
/// `SIMULTANEOUS_WORKERS_MAX`
const WORKERS_MAX: u32 = 10;
/// `WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH`
const CUSTOM_JOB_MAX_LENGTH: usize = 160;
/// `DEFAULT_WORKER_PROFILE_ID`
pub(super) const DEFAULT_ID: &str = "default";

/// `WorkerProfileJob`
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum Job {
    Builtin { job: String },
    Custom { text: String },
}

/// `WorkerProfile`, as the editor reads it.
#[derive(Deserialize)]
pub(super) struct Profile {
    pub(super) id: String,
    #[serde(default)]
    pub(super) label: String,
    #[serde(default)]
    pub(super) enabled: bool,
    pub(super) job: Job,
    pub(super) domain: Option<String>,
    #[serde(default)]
    pub(super) model: String,
    pub(super) reasoning_effort: Option<ReasoningEffort>,
    pub(super) prompt: Option<String>,
}

/// A field of the profile that a text input commits.
#[derive(Clone, Copy)]
pub(super) enum Field {
    Label,
    Domain,
    Prompt,
    Job,
}

/// A partial profile: `Value::Null` removes the field (React's `undefined`).
pub(super) type Partial = Vec<(&'static str, Value)>;

/// `{...profile, ...partial}`
pub(super) fn merged(profile: &Value, partial: Partial) -> Value {
    let mut next = profile.clone();
    if let Some(object) = next.as_object_mut() {
        for (key, value) in partial {
            if value.is_null() {
                object.remove(key);
            } else {
                object.insert(key.to_owned(), value);
            }
        }
    }
    next
}

/// `lowestFreeNumber`
fn lowest_free(taken: &[String], format: impl Fn(usize) -> String) -> usize {
    (1..=LIMIT)
        .find(|n| !taken.contains(&format(*n).to_lowercase()))
        .unwrap_or(LIMIT)
}

/// `createWorkerProfileInNextSlot`: `None` at the limit.
pub(super) fn create_profile(profiles: &[Value], models: &[ModelChoice]) -> Option<Value> {
    if profiles.len() >= LIMIT {
        return None;
    }
    let text = |profile: &Value, key: &str| {
        profile
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let ids: Vec<String> = profiles
        .iter()
        .map(|profile| text(profile, "id").to_lowercase())
        .collect();
    let labels: Vec<String> = profiles
        .iter()
        .map(|profile| text(profile, "label").trim().to_lowercase())
        .collect();
    let id = format!("w{}", lowest_free(&ids, |n| format!("w{n}")));
    let label = format!("Worker {}", lowest_free(&labels, |n| format!("Worker {n}")));
    let default = profiles
        .iter()
        .find(|profile| profile.get("id").and_then(Value::as_str) == Some(DEFAULT_ID));
    let fallback = models.first();
    let model = default
        .and_then(|profile| profile.get("model").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| fallback.map(|model| model.model_ref.to_string()))
        .unwrap_or_default();
    let effort = default
        .and_then(|profile| profile.get("reasoning_effort").and_then(Value::as_str))
        .or_else(|| {
            fallback
                .and_then(|model| model.default_reasoning_effort.as_ref())
                .and_then(effort_wire)
        })
        .unwrap_or("medium");
    Some(json!({
        "id": id,
        "label": label,
        "enabled": true,
        "job": { "kind": "builtin", "job": "coding" },
        "model": model,
        "reasoning_effort": effort,
    }))
}

/// `removeWorkerProfileById`: the default profile stays.
pub(super) fn without(profiles: &[Value], id: &str) -> Vec<Value> {
    profiles
        .iter()
        .filter(|profile| id == DEFAULT_ID || profile.get("id").and_then(Value::as_str) != Some(id))
        .cloned()
        .collect()
}

/// `normalizeSimultaneousWorkers`: `None` for text that is not a whole number in range, or the
/// current value.
pub(super) fn simultaneous_workers(raw: &str, current: u32) -> Option<u32> {
    let raw = raw.trim();
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: u32 = raw.parse().ok()?;
    ((WORKERS_MIN..=WORKERS_MAX).contains(&value) && value != current).then_some(value)
}

/// `selectWorkerProfileModel`: the model and the effort that goes with it.
pub(super) fn select_model(
    models: &[ModelChoice],
    model_ref: &str,
    current: &ReasoningEffort,
) -> Partial {
    let effort = match models
        .iter()
        .find(|model| model.model_ref.as_ref() == model_ref)
    {
        Some(next) => model_choice(next, current).1,
        None => ReasoningEffort::Medium,
    };
    vec![
        ("model", json!(model_ref)),
        (
            "reasoning_effort",
            json!(effort_wire(&effort).unwrap_or("medium")),
        ),
    ]
}

/// `workerProfileTextPatch`: the patch for a committed text, or `None` when it changes nothing.
pub(super) fn text_patch(profile: &Profile, field: Field, raw: &str) -> Option<Partial> {
    let trimmed = raw.trim();
    match field {
        Field::Label => (!trimmed.is_empty() && trimmed != profile.label)
            .then(|| vec![("label", json!(trimmed))]),
        Field::Job => {
            if matches!(&profile.job, Job::Custom { text } if text.trim() == trimmed) {
                return None;
            }
            // commitWorkerProfileCustomJob
            let valid = !trimmed.is_empty() && trimmed.chars().count() <= CUSTOM_JOB_MAX_LENGTH;
            valid.then(|| vec![("job", json!({ "kind": "custom", "text": trimmed }))])
        }
        Field::Domain | Field::Prompt => {
            let (key, current) = match field {
                Field::Domain => ("domain", &profile.domain),
                _ => ("prompt", &profile.prompt),
            };
            if trimmed == current.as_deref().unwrap_or_default().trim() {
                return None;
            }
            let value = if trimmed.is_empty() {
                Value::Null
            } else {
                json!(trimmed)
            };
            Some(vec![(key, value)])
        }
    }
}

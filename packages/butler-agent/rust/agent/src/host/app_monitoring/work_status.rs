//! Actual BTCC Work facts for the source work-status projection.

use crate::public_text::fixed_regex::fixed_regex;
use std::sync::{Arc, LazyLock};

use regex::Regex;

use crate::{
    btcc::{SessionWorkRepository, WorkStatusObservation},
    gateway::{AppBoundWorkStatusFact, AppWorkOperationalNoticeFact, GatewayApplicationError},
};

pub(super) async fn read(
    session_work: Arc<SessionWorkRepository>,
) -> Result<Vec<AppBoundWorkStatusFact>, GatewayApplicationError> {
    let observations = session_work
        .work_status_observations()
        .await
        .map_err(|_| GatewayApplicationError::Internal)?;
    Ok(observations
        .into_iter()
        .filter_map(project_observation)
        .collect())
}

fn project_observation(observation: WorkStatusObservation) -> Option<AppBoundWorkStatusFact> {
    if observation.work_status == "abandoned" {
        return None;
    }
    let ids = [
        observation.work_id.as_str(),
        observation.session_id.as_str(),
        observation.turn_id.as_deref().unwrap_or(""),
    ];
    let operational_notice =
        observation
            .operational_notice
            .map(|notice| AppWorkOperationalNoticeFact {
                status: notice.status,
                summary: safe_work_text(&notice.summary, "Operational status changed.", ids),
                created_at: notice.created_at,
            });
    let updated_at = latest_timestamp([
        observation.work_updated_at.as_str(),
        observation.disposition_updated_at.as_deref().unwrap_or(""),
        observation.checkpoint_updated_at.as_deref().unwrap_or(""),
        operational_notice
            .as_ref()
            .map_or("", |notice| notice.created_at.as_str()),
    ]);
    Some(AppBoundWorkStatusFact {
        session_id: observation.session_id.clone(),
        status: observation.work_status,
        disposition_status: observation.disposition_status,
        turn_state: observation.turn_state,
        runtime_owned_open: observation.runtime_owned_open,
        safe_title: safe_work_text(
            observation.safe_title.as_deref().unwrap_or(""),
            "Butler work",
            ids,
        ),
        summary: safe_work_text(
            observation.summary.as_deref().unwrap_or(""),
            "Work status is available.",
            ids,
        ),
        stage: observation.stage,
        action_progress: observation.action_progress,
        effect_count: observation.effect_count,
        unresolved_blocker_count: observation.unresolved_blocker_count,
        updated_at,
        operational_notice,
    })
}

fn safe_work_text(value: &str, fallback: &str, ids: [&str; 3]) -> String {
    static PATHS: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(r"(?:/Users|/home|/var|/tmp)/[^\s),;]+|\b[A-Za-z]:\\[^\s),;]+")
    });
    static SECRETS: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|credential|session[_-]?key)\s*[:=]\s*(?:bearer\s+)?\S+",
        )
    });
    static BEARER: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?i)\bbearer\s+[\w.~+/=-]+"));
    let mut text = value.to_owned();
    for id in ids.into_iter().filter(|id| !id.is_empty()) {
        text = text.replace(id, "internal reference");
    }
    text = PATHS.replace_all(&text, "local path").into_owned();
    text = SECRETS.replace_all(&text, "[redacted]").into_owned();
    text = BEARER.replace_all(&text, "Bearer [redacted]").into_owned();
    let safe = crate::public_text::sanitize_public_text(&text, fallback);
    let compact = safe.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = compact.chars();
    let value = chars.by_ref().take(180).collect::<String>();
    if compact.is_empty() {
        fallback.into()
    } else if chars.next().is_some() {
        format!("{}...", value.chars().take(177).collect::<String>())
    } else {
        value
    }
}

fn latest_timestamp<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .filter(|value| !value.is_empty())
        .max_by_key(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map_or(0, |timestamp| timestamp.timestamp_millis())
        })
        .unwrap_or_default()
        .to_owned()
}

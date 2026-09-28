//! Onboarding state the App keeps in the agent (#230), settings field
//! `onboarding: {consent_version, accepted_at, completed_at}`.
//!
//! The App owns the meaning: it skips first-run setup once `completed_at`
//! is set, and a newer `consent_version` than the accepted one shows the
//! consent step again. The agent stores and validates the values.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// Settings key of the onboarding state.
pub(super) const KEY: &str = "onboarding";

/// Longest accepted timestamp text.
const MAX_TIMESTAMP_CHARS: usize = 64;

/// The stored onboarding state; every field may be null.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(super) struct Onboarding {
    pub(super) consent_version: Option<u32>,
    pub(super) accepted_at: Option<String>,
    pub(super) completed_at: Option<String>,
}

/// A PATCH of the onboarding state: a field that is present replaces the
/// stored one (`null` clears it); an absent field keeps it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OnboardingPatch {
    #[serde(default, deserialize_with = "present")]
    consent_version: Option<Option<u32>>,
    #[serde(default, deserialize_with = "present")]
    accepted_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    completed_at: Option<Option<String>>,
}

/// Marks a field that is present in the input, including an explicit null.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl OnboardingPatch {
    fn parse(value: &Value) -> Option<Self> {
        let patch = Self::deserialize(value).ok()?;
        let valid = [&patch.accepted_at, &patch.completed_at]
            .into_iter()
            .flatten()
            .flatten()
            .all(|value| is_timestamp(value));
        valid.then_some(patch)
    }

    fn apply(self, mut onboarding: Onboarding) -> Onboarding {
        if let Some(value) = self.consent_version {
            onboarding.consent_version = value;
        }
        if let Some(value) = self.accepted_at {
            onboarding.accepted_at = value;
        }
        if let Some(value) = self.completed_at {
            onboarding.completed_at = value;
        }
        onboarding
    }
}

/// RFC 3339 date-time text, as the App writes `Date.prototype.toISOString`.
fn is_timestamp(value: &str) -> bool {
    value.chars().count() <= MAX_TIMESTAMP_CHARS
        && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// Whether `value` is an acceptable `onboarding` PATCH value.
pub(super) fn is_patch(value: &Value) -> bool {
    OnboardingPatch::parse(value).is_some()
}

/// The onboarding state of a stored or projected settings object; a
/// missing or unreadable value reads as all null.
pub(super) fn view(settings: &Map<String, Value>) -> Value {
    let onboarding = settings
        .get(KEY)
        .and_then(|value| Onboarding::deserialize(value).ok())
        .unwrap_or_default();
    serde_json::to_value(onboarding).unwrap_or(Value::Null)
}

/// Adds the merged onboarding state to a sanitized settings `patch` when
/// the request `input` changes it. `current` is the settings view.
pub(super) fn merge_into_patch(patch: &mut Value, input: &Value, current: &Value) {
    let (Some(requested), Some(patch)) = (
        input.get(KEY).and_then(OnboardingPatch::parse),
        patch.as_object_mut(),
    ) else {
        return;
    };
    let stored = current
        .get(KEY)
        .and_then(|value| Onboarding::deserialize(value).ok())
        .unwrap_or_default();
    if let Ok(merged) = serde_json::to_value(requested.apply(stored)) {
        patch.insert(KEY.into(), merged);
    }
}

/// Copies the patch's onboarding state into the settings `projection`.
pub(super) fn project(projection: &mut Value, patch: &Value) {
    if let (Some(value), Some(projection)) = (patch.get(KEY), projection.as_object_mut()) {
        projection.insert(KEY.into(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn patches_accept_partial_state_and_reject_malformed_values() {
        for valid in [
            json!({}),
            json!({"consent_version": 1, "accepted_at": "2026-09-28T01:02:03.456Z"}),
            json!({"completed_at": null}),
            json!({"consent_version": null, "accepted_at": null, "completed_at": "2026-09-28T01:02:03+09:00"}),
        ] {
            assert!(is_patch(&valid), "{valid}");
        }
        for invalid in [
            json!(null),
            json!({"consent_version": -1}),
            json!({"consent_version": 1.5}),
            json!({"consent_version": "1"}),
            json!({"accepted_at": "yesterday"}),
            json!({"completed_at": 1}),
            json!({"completed": "2026-09-28T01:02:03Z"}),
        ] {
            assert!(!is_patch(&invalid), "{invalid}");
        }
    }

    #[test]
    fn merge_keeps_absent_fields_and_clears_nulls() {
        let current = json!({"onboarding": {"consent_version": 1,
            "accepted_at": "2026-09-01T00:00:00Z", "completed_at": "2026-09-01T00:05:00Z"}});
        let mut patch = json!({});
        merge_into_patch(
            &mut patch,
            &json!({"onboarding": {"consent_version": 2, "completed_at": null}}),
            &current,
        );
        assert_eq!(
            patch["onboarding"],
            json!({"consent_version": 2, "accepted_at": "2026-09-01T00:00:00Z", "completed_at": null})
        );
        assert_eq!(
            view(&Map::new()),
            json!({"consent_version": null, "accepted_at": null, "completed_at": null})
        );
    }
}

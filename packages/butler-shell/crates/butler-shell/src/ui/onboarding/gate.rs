//! The onboarding gate (`app/onboarding.ts`): the Agent's `settings.onboarding` decides whether
//! the first run or a consent renewal shows. gpui has no renderer storage, so the legacy
//! `butler:first-run-setup:v1` flag is not read.
use serde_json::{Map, Value};

/// What the window shows: nothing yet, the first run, a consent renewal, or the workspace.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Gate {
    Pending,
    FirstRun,
    Consent,
    Workspace,
}

/// `FIRST_RUN_CONSENT_VERSION`: the app owns the consent text, so it owns its version.
pub(crate) const CONSENT_VERSION: u64 = 2;

/// `resolveOnboardingGate` for loaded settings: no `onboarding` object or no `completed_at` →
/// first run; a current consent → workspace; else consent.
pub(crate) fn resolve(settings: &Value) -> Gate {
    let Some(onboarding) = settings.get("onboarding").filter(|value| value.is_object()) else {
        return Gate::FirstRun;
    };
    let completed = onboarding
        .get("completed_at")
        .and_then(Value::as_str)
        .is_some_and(|at| !at.is_empty());
    if !completed {
        Gate::FirstRun
    } else if consent_is_current(onboarding) {
        Gate::Workspace
    } else {
        Gate::Consent
    }
}

/// `consentIsCurrent`: the accepted version is at least [`CONSENT_VERSION`].
pub(crate) fn consent_is_current(onboarding: &Value) -> bool {
    onboarding
        .get("consent_version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version >= CONSENT_VERSION as f64)
}

/// `consentAcceptedPatch`: `{onboarding: {...current, consent_version: 2, accepted_at}}`.
pub(crate) fn consent_accepted_patch(current: &Value, accepted_at: &str) -> Value {
    let mut onboarding = current.as_object().cloned().unwrap_or_else(Map::new);
    onboarding.insert("consent_version".into(), Value::from(CONSENT_VERSION));
    onboarding.insert("accepted_at".into(), Value::from(accepted_at));
    let mut patch = Map::new();
    patch.insert("onboarding".into(), Value::Object(onboarding));
    Value::Object(patch)
}

//! Applying a first-chat onboarding update: names, persona and answers,
//! then profiling consent, and a consolidation pass when the update gave
//! the profile something to learn from.

use std::path::PathBuf;
use std::sync::Arc;

use super::super::contracts::*;
use super::super::presets::{PersonaLocale, PersonaPresets};
use super::super::{candidates, naming, onboarding, storage};
use super::with_lease;
use crate::coordination::CognitionWriteCoordinator;

/// What an onboarding update writes to.
pub(super) struct OnboardingWrite {
    pub root: PathBuf,
    pub host: Arc<dyn ProfileHostFacts>,
    pub presets: Arc<PersonaPresets>,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub sources: Arc<dyn CanonicalProfileSourceFactory>,
    pub lock: PathBuf,
}

impl OnboardingWrite {
    pub(super) fn apply(
        self,
        input: &FirstChatOnboardingUpdate,
    ) -> ProfileResult<FirstChatOnboardingUpdateResult> {
        let host = self.host.as_ref();
        let now = host.now_iso();
        let now_ms = host.now_epoch_millis();
        let mut state = onboarding::read(&self.root, &now);
        let (profile, mut updated) = self.update_names(input, &now, now_ms)?;
        let locale = if input.locale.as_deref() == Some("ko") {
            PersonaLocale::Ko
        } else {
            PersonaLocale::En
        };
        let selected = onboarding::resolve_persona_selection(
            &self.presets,
            locale,
            input.persona_preset.as_deref(),
            input.persona_custom.as_deref(),
        );
        updated.extend(onboarding::apply_update_fields(
            &mut state,
            input,
            selected.as_deref(),
        ));
        let applied = onboarding::apply_persona(
            &self.root,
            &self.presets,
            &state,
            &profile,
            selected.as_deref(),
            locale,
        )?;
        if input.complete {
            state.status = "complete".into();
            state.completed_at = Some(host.now_iso());
        }
        state.updated_at = host.now_iso();
        state = onboarding::write(
            &self.root,
            &state,
            host.process_id(),
            host.now_epoch_millis(),
        )?;
        let mode = input
            .profiling_mode
            .unwrap_or_else(|| storage::read_consent(&self.root).mode);
        let consent = storage::write_consent(&self.root, mode, None, None, &host.now_iso())?;
        if consent.mode != ProfilingMode::Off && has_observation(&profile, &state) {
            self.consolidate(consent.mode)?;
        }
        updated.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        updated.dedup();
        Ok(FirstChatOnboardingUpdateResult {
            ok: true,
            status: state.status.clone(),
            updated_fields: updated,
            skipped_fields: state.skipped_fields.clone(),
            profile: OnboardingProfileResult {
                has_principal_name: !profile.principal_name.is_empty(),
                has_preferred_address: !profile.preferred_address.is_empty(),
                has_butler_nickname: !profile.butler_nickname.is_empty(),
            },
            persona: OnboardingPersonaResult {
                preset: selected.or_else(|| state.fields.persona_preset.clone()),
                applied,
            },
            profiling: OnboardingProfilingResult {
                mode: consent.mode,
                captured_candidate_count: 0,
                raw_text_included: false,
            },
            storage_label: onboarding::STORAGE_LABEL.into(),
        })
    }

    /// Writes the names the update carries; the resulting profile and the
    /// names that were given.
    fn update_names(
        &self,
        input: &FirstChatOnboardingUpdate,
        now: &str,
        now_ms: i64,
    ) -> ProfileResult<(PersonalizationProfile, Vec<String>)> {
        let updated = [
            ("principal_name", &input.principal_name),
            ("preferred_address", &input.preferred_address),
            ("butler_nickname", &input.butler_nickname),
        ]
        .into_iter()
        .filter(|(_, value)| value.is_some())
        .map(|(name, _)| name.to_owned())
        .collect::<Vec<_>>();
        let profile = if updated.is_empty() {
            naming::read(&self.root)
        } else {
            let names = PersonalizationProfileUpdate {
                butler_nickname: input.butler_nickname.clone(),
                principal_name: input.principal_name.clone(),
                preferred_address: input.preferred_address.clone(),
            };
            naming::update(&self.root, &names, now, self.host.process_id(), now_ms)?
        };
        Ok((profile, updated))
    }

    fn consolidate(self, mode: ProfilingMode) -> ProfileResult<()> {
        let now = self.host.now_iso();
        let now_ms = self.host.now_epoch_millis();
        with_lease(&self.coordinator, self.lock, "consolidation", || {
            candidates::consolidate(&self.root, self.sources.as_ref(), mode, &now, now_ms)
        })?;
        Ok(())
    }
}

/// Whether the update left the profile anything to learn from.
fn has_observation(profile: &PersonalizationProfile, state: &FirstChatOnboardingState) -> bool {
    let answered = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    !profile.principal_name.is_empty()
        || !profile.preferred_address.is_empty()
        || answered(&state.fields.interests)
        || answered(&state.fields.work)
        || answered(&state.fields.service_preference)
}

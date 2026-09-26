mod async_operations;
mod extraction;
mod personalization;
mod prompt_port;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::contracts::*;
use super::{candidates, extractor_config, naming, onboarding, projection, storage};
use crate::configuration::ConfigurationWrites;
use crate::coordination::{CognitionWriteAcquire, CognitionWriteCoordinator};
use crate::models::ProviderPromptPort;
use crate::profile::presets::{PersonaLocale, PersonaPresets};

const LOCAL_OPERATION_LIMIT: usize = 4;

pub(crate) struct ProfileService {
    data_root: PathBuf,
    cognition_root: PathBuf,
    presets: Arc<PersonaPresets>,
    configuration_writes: Arc<ConfigurationWrites>,
    coordinator: Arc<CognitionWriteCoordinator>,
    host: Arc<dyn ProfileHostFacts>,
    canonical_sources: Arc<dyn CanonicalProfileSourceFactory>,
    provider: Arc<dyn ProviderPromptPort>,
    admission: Arc<Semaphore>,
    async_admission: Arc<Semaphore>,
    shutdown: CancellationToken,
    active_claims: Arc<Mutex<HashSet<String>>>,
    operations: TaskTracker,
    lifecycle: Mutex<Lifecycle>,
}

struct Lifecycle {
    closing: bool,
}

impl ProfileService {
    pub(crate) async fn read_coverage_health(&self) -> ProfileResult<serde_json::Value> {
        let root = self.data_root.clone();
        let sources = self.canonical_sources.clone();
        self.run(move || Ok(super::coverage_health::read(&root, sources.as_ref())))
            .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "constructs the profile service from its required runtime collaborators"
    )]
    pub(crate) fn new(
        data_root: PathBuf,
        cognition_root: PathBuf,
        presets: Arc<PersonaPresets>,
        configuration_writes: Arc<ConfigurationWrites>,
        coordinator: Arc<CognitionWriteCoordinator>,
        host: Arc<dyn ProfileHostFacts>,
        canonical_sources: Arc<dyn CanonicalProfileSourceFactory>,
        provider: Arc<dyn ProviderPromptPort>,
    ) -> Self {
        Self {
            data_root,
            cognition_root,
            presets,
            configuration_writes,
            coordinator,
            host,
            canonical_sources,
            provider,
            admission: Arc::new(Semaphore::new(LOCAL_OPERATION_LIMIT)),
            async_admission: Arc::new(Semaphore::new(LOCAL_OPERATION_LIMIT)),
            shutdown: CancellationToken::new(),
            active_claims: Arc::new(Mutex::new(HashSet::new())),
            operations: TaskTracker::new(),
            lifecycle: Mutex::new(Lifecycle { closing: false }),
        }
    }

    pub(crate) async fn close(&self) {
        {
            let mut lifecycle = self.lifecycle.lock().unwrap();
            if !lifecycle.closing {
                lifecycle.closing = true;
                self.shutdown.cancel();
                self.operations.close();
            }
        }
        self.operations.wait().await;
    }

    pub(crate) async fn read_personalization_profile(
        &self,
    ) -> ProfileResult<PersonalizationProfile> {
        let root = self.data_root.clone();
        self.run(move || Ok(naming::read(&root))).await
    }

    pub(crate) async fn update_personalization_profile(
        &self,
        input: PersonalizationProfileUpdate,
    ) -> ProfileResult<PersonalizationProfile> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let host = self.host.clone();
        self.run(move || {
            let _guard = guard;
            naming::update(
                &root,
                &input,
                &host.now_iso(),
                host.process_id(),
                host.now_epoch_millis(),
            )
        })
        .await
    }

    pub(crate) async fn render_first_chat_onboarding(
        &self,
        locale: &str,
    ) -> ProfileResult<Option<String>> {
        let root = self.data_root.clone();
        let host = self.host.clone();
        let presets = self.presets.clone();
        let locale = if locale == "ko" {
            PersonaLocale::Ko
        } else {
            PersonaLocale::En
        };
        self.run(move || Ok(onboarding::render(&root, &presets, locale, &host.now_iso())))
            .await
    }

    pub(crate) async fn update_first_chat_onboarding(
        &self,
        input: FirstChatOnboardingUpdate,
    ) -> ProfileResult<FirstChatOnboardingUpdateResult> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let host = self.host.clone();
        let presets = self.presets.clone();
        let coordinator = self.coordinator.clone();
        let sources = self.canonical_sources.clone();
        let lock = self.lock_path();
        self.run(move || {
            let _guard = guard;
            let now = host.now_iso();
            let now_ms = host.now_epoch_millis();
            let mut state = onboarding::read(&root, &now);
            let mut updated = Vec::new();
            let profile_input = PersonalizationProfileUpdate {
                butler_nickname: input.butler_nickname.clone(),
                principal_name: input.principal_name.clone(),
                preferred_address: input.preferred_address.clone(),
            };
            for (name, value) in [
                ("principal_name", &input.principal_name),
                ("preferred_address", &input.preferred_address),
                ("butler_nickname", &input.butler_nickname),
            ] {
                if value.is_some() {
                    updated.push(name.into())
                }
            }
            let profile = if updated.is_empty() {
                naming::read(&root)
            } else {
                naming::update(&root, &profile_input, &now, host.process_id(), now_ms)?
            };
            let locale = if input.locale.as_deref() == Some("ko") {
                PersonaLocale::Ko
            } else {
                PersonaLocale::En
            };
            let selected = onboarding::resolve_persona_selection(
                &presets,
                locale,
                input.persona_preset.as_deref(),
                input.persona_custom.as_deref(),
            );
            updated.extend(onboarding::apply_update_fields(
                &mut state,
                &input,
                selected.as_deref(),
            ));
            let applied = onboarding::apply_persona(
                &root,
                &presets,
                &state,
                &profile,
                selected.as_deref(),
                locale,
            )?;
            if input.complete {
                state.status = "complete".into();
                state.completed_at = Some(host.now_iso())
            }
            state.updated_at = host.now_iso();
            state = onboarding::write(&root, &state, host.process_id(), host.now_epoch_millis())?;
            let mode = input
                .profiling_mode
                .unwrap_or_else(|| storage::read_consent(&root).mode);
            let consent = storage::write_consent(&root, mode, None, None, &host.now_iso())?;
            let has_observation = !profile.principal_name.is_empty()
                || !profile.preferred_address.is_empty()
                || state
                    .fields
                    .interests
                    .as_deref()
                    .is_some_and(|value| !value.is_empty())
                || state
                    .fields
                    .work
                    .as_deref()
                    .is_some_and(|value| !value.is_empty())
                || state
                    .fields
                    .service_preference
                    .as_deref()
                    .is_some_and(|value| !value.is_empty());
            if consent.mode != ProfilingMode::Off && has_observation {
                let consolidate_now = host.now_iso();
                let consolidate_ms = host.now_epoch_millis();
                with_lease(&coordinator, lock, "consolidation", || {
                    candidates::consolidate(
                        &root,
                        sources.as_ref(),
                        consent.mode,
                        &consolidate_now,
                        consolidate_ms,
                    )
                })?;
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
        })
        .await
    }

    pub(crate) async fn read_profiling_consent(&self) -> ProfileResult<ProfilingConsentSnapshot> {
        let root = self.data_root.clone();
        self.run(move || Ok(storage::read_consent(&root))).await
    }

    pub(crate) async fn set_profiling_mode(
        &self,
        mode: ProfilingMode,
    ) -> ProfileResult<ProfilingConsentSnapshot> {
        let root = self.data_root.clone();
        let host = self.host.clone();
        self.run(move || storage::write_consent(&root, mode, None, None, &host.now_iso()))
            .await
    }

    pub(crate) async fn clear_profiling_data(&self) -> ProfileResult<ClearProfilingResult> {
        let root = self.data_root.clone();
        self.run(move || storage::clear(&root)).await
    }

    pub(crate) async fn read_extractor_model(
        &self,
    ) -> ProfileResult<ProfilingExtractorModelSnapshot> {
        let root = self.data_root.clone();
        self.run(move || Ok(extractor_config::read(&root))).await
    }

    pub(crate) async fn set_extractor_model(
        &self,
        model: Option<String>,
    ) -> ProfileResult<ProfilingExtractorModelSnapshot> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let host = self.host.clone();
        self.run(move || {
            let _guard = guard;
            extractor_config::set_model(
                &root,
                model.as_deref(),
                host.process_id(),
                host.now_epoch_millis(),
            )
        })
        .await
    }

    pub(crate) async fn set_extractor_reasoning_effort(
        &self,
        effort: Option<String>,
    ) -> ProfileResult<ProfilingExtractorModelSnapshot> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let host = self.host.clone();
        self.run(move || {
            let _guard = guard;
            extractor_config::set_reasoning(
                &root,
                effort.as_deref(),
                host.process_id(),
                host.now_epoch_millis(),
            )
        })
        .await
    }

    pub(crate) async fn read_runtime_profile_projection(
        &self,
    ) -> ProfileResult<Option<RuntimeProfileProjection>> {
        let root = self.data_root.clone();
        let sources = self.canonical_sources.clone();
        let now = self.host.now_epoch_millis();
        match self
            .run(move || projection::read_current(&root, sources.as_ref(), now))
            .await
        {
            Ok(value) => Ok(value),
            Err(error) if error.code != "profile_closed" => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn reflective_summary(
        &self,
        locale: &str,
    ) -> ProfileResult<ReflectiveProfileSummary> {
        let root = self.data_root.clone();
        let locale = locale.to_owned();
        self.run(move || projection::reflective(&root, &locale))
            .await
    }

    pub(crate) async fn consolidate_profile_candidates(
        &self,
    ) -> ProfileResult<ProfileConsolidationResult> {
        let root = self.data_root.clone();
        let coordinator = self.coordinator.clone();
        let sources = self.canonical_sources.clone();
        let lock = self.lock_path();
        let now = self.host.now_iso();
        let now_ms = self.host.now_epoch_millis();
        self.run(move || {
            with_lease(&coordinator, lock, "consolidation", || {
                let mode = storage::read_consent(&root).mode;
                candidates::consolidate(&root, sources.as_ref(), mode, &now, now_ms)
            })
        })
        .await
    }

    fn lock_path(&self) -> PathBuf {
        self.cognition_root
            .join("consolidation/locks/consolidation.lock")
    }

    pub(super) async fn run<T, F>(&self, operation: F) -> ProfileResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> ProfileResult<T> + Send + 'static,
    {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ProfileError::new("profile_closed", "Profile service is closed."))?;
        let token = {
            let lifecycle = self.lifecycle.lock().unwrap();
            if lifecycle.closing {
                return Err(ProfileError::new(
                    "profile_closed",
                    "Profile service is closed.",
                ));
            }
            self.operations.token()
        };
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _token = token;
            operation()
        })
        .await
        .map_err(|_| ProfileError::new("profile_operation_failed", "Profile operation failed."))?
    }
}

fn with_lease<T, F>(
    coordinator: &CognitionWriteCoordinator,
    lock: PathBuf,
    purpose: &str,
    operation: F,
) -> ProfileResult<T>
where
    F: FnOnce() -> ProfileResult<T>,
{
    let lease = coordinator
        .try_acquire(CognitionWriteAcquire::immediate(lock, purpose))
        .map_err(|_| {
            ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
        })?
        .ok_or_else(|| ProfileError::new("memory_write_busy", "Memory writer is busy."))?;
    let result = operation();
    let release = lease.release(result.is_ok()).map_err(|_| {
        ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
    });
    match (result, release) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

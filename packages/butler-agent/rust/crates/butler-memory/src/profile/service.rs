//! The profile service: consent, personalization, onboarding, candidate
//! capture and consolidation behind one admission-controlled handle.

mod async_operations;
mod extraction;
mod onboarding_update;
mod personalization;
mod prompt_port;
mod reset;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::contracts::*;
use super::{candidates, extractor_config, naming, onboarding, projection, storage};
use crate::coordination::{CognitionWriteAcquire, CognitionWriteCoordinator};
use crate::profile::ProfileCode;
use crate::profile::presets::{PersonaLocale, PersonaPresets};
use butler_core::configuration::ConfigurationWrites;
use butler_models::models::ProviderPromptPort;

const LOCAL_OPERATION_LIMIT: usize = 4;

/// The user profile: names, onboarding, profiling consent, candidate capture and consolidation.
pub struct ProfileService {
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
    /// How much of the conversation the profile extractor has covered.
    pub async fn read_coverage_health(
        &self,
    ) -> ProfileResult<super::coverage_health::ProfileCoverageHealth> {
        let root = self.data_root.clone();
        let sources = self.canonical_sources.clone();
        self.run(move || Ok(super::coverage_health::read(&root, sources.as_ref())))
            .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "constructs the profile service from its required runtime collaborators"
    )]
    /// A profile service over `data_root`.
    pub fn new(
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

    /// Stops admitting operations and waits for running ones.
    pub async fn close(&self) {
        {
            let mut lifecycle = self.lifecycle.lock();
            if !lifecycle.closing {
                lifecycle.closing = true;
                self.shutdown.cancel();
                self.operations.close();
            }
        }
        self.operations.wait().await;
    }

    /// The names Butler and the user go by.
    pub async fn read_personalization_profile(&self) -> ProfileResult<PersonalizationProfile> {
        let root = self.data_root.clone();
        self.run(move || Ok(naming::read(&root))).await
    }

    /// Changes the names.
    pub async fn update_personalization_profile(
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

    /// Records first-chat onboarding answers, applies the persona and consent, and consolidates
    /// when there is something to learn.
    pub async fn update_first_chat_onboarding(
        &self,
        input: FirstChatOnboardingUpdate,
    ) -> ProfileResult<FirstChatOnboardingUpdateResult> {
        let guard = self.configuration_writes.acquire_owned().await;
        let write = onboarding_update::OnboardingWrite {
            root: self.data_root.clone(),
            host: self.host.clone(),
            presets: self.presets.clone(),
            coordinator: self.coordinator.clone(),
            sources: self.canonical_sources.clone(),
            lock: self.lock_path(),
        };
        self.run(move || {
            let _guard = guard;
            write.apply(&input)
        })
        .await
    }

    /// The profiling consent in effect.
    pub async fn read_profiling_consent(&self) -> ProfileResult<ProfilingConsentSnapshot> {
        let root = self.data_root.clone();
        self.run(move || Ok(storage::read_consent(&root))).await
    }

    /// Sets the profiling mode.
    pub async fn set_profiling_mode(
        &self,
        mode: ProfilingMode,
    ) -> ProfileResult<ProfilingConsentSnapshot> {
        let root = self.data_root.clone();
        let host = self.host.clone();
        self.coordinator.invalidate_inventory();
        let result = self
            .run(move || storage::write_consent(&root, mode, None, None, &host.now_iso()))
            .await;
        self.coordinator.invalidate_inventory();
        result
    }

    /// Clears profile content while retaining a durable future admission boundary.
    pub async fn clear_profiling_data(&self) -> ProfileResult<ClearProfilingResult> {
        self.reset_profiling_data(uuid::Uuid::new_v4().to_string(), CancellationToken::new())
            .await
    }

    /// The profile extractor model.
    pub async fn read_extractor_model(&self) -> ProfileResult<ProfilingExtractorModelSnapshot> {
        let root = self.data_root.clone();
        self.run(move || Ok(extractor_config::read(&root))).await
    }

    /// Sets (or clears) the extractor model.
    pub async fn set_extractor_model(
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

    /// Sets the extractor reasoning effort.
    pub async fn set_extractor_reasoning_effort(
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

    /// The runtime projection for prompts, when profiling is on.
    pub async fn read_runtime_profile_projection(
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
            Err(error) if error.code() != "profile_closed" => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Butler's current understanding of the user, in `locale`.
    pub async fn reflective_summary(
        &self,
        locale: &str,
    ) -> ProfileResult<ReflectiveProfileSummary> {
        let root = self.data_root.clone();
        let locale = locale.to_owned();
        self.run(move || projection::reflective(&root, &locale))
            .await
    }

    /// Promotes ready candidates and refreshes the runtime projection.
    pub async fn consolidate_profile_candidates(
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
            .map_err(|source| {
                ProfileError::new(ProfileCode::ProfileClosed, "Profile service is closed.")
                    .with_source(source)
            })?;
        let token = {
            let lifecycle = self.lifecycle.lock();
            if lifecycle.closing {
                return Err(ProfileError::new(
                    ProfileCode::ProfileClosed,
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
        .map_err(|source| {
            ProfileError::new(
                ProfileCode::ProfileOperationFailed,
                "Profile operation failed.",
            )
            .with_source(source)
        })?
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
        .try_acquire(&CognitionWriteAcquire::immediate(lock, purpose))
        .map_err(|source| {
            ProfileError::new(
                ProfileCode::ProfileStoreUnavailable,
                "Profile store is unavailable.",
            )
            .with_source(source)
        })?
        .ok_or_else(|| ProfileError::new(ProfileCode::MemoryWriteBusy, "Memory writer is busy."))?;
    complete_leased(lease, operation)
}

fn complete_leased<T>(
    lease: crate::coordination::CognitionWriteLease,
    operation: impl FnOnce() -> ProfileResult<T>,
) -> ProfileResult<T> {
    let result = operation();
    let release = lease.release(result.is_ok()).map_err(|source| {
        ProfileError::new(
            ProfileCode::ProfileStoreUnavailable,
            "Profile store is unavailable.",
        )
        .with_source(source)
    });
    match (result, release) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

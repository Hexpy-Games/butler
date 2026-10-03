//! The two source 04:00 jobs over the live process's existing owners.

use std::{path::PathBuf, sync::Arc, time::SystemTime};

use tokio_util::sync::CancellationToken;

use butler_ledger::project_ledger::ProjectLedger;
use butler_memory::cognition::{
    CognitionPathEnvironment, ConfiguredCycleOptions, ConfiguredCycleResult,
    ConfiguredCycleService, CycleService, CycleStatus, FeedbackBufferService,
    GraphConsolidationService, KnowHowService, LegacyMetadataIntegrityService, MemoryHealthService,
    MemorySyncConsumer, ProjectCapsuleService, RunCycle, VectorOptimizeService,
    active_memory_descriptor_exists, resolve_active_generation,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_memory::profile::ProfileService;
use butler_models::models::{ModelConfiguration, ModelProvider};
use butler_runtime::operations::{CycleMetrics, MetricFiles};
use butler_turn::workspace::SessionBindingStore;

use crate::host::memory_jobs::briefing::BriefingGeneration;
use crate::host::memory_jobs::consolidation_phase::CyclePhases;
use crate::host::memory_jobs::maintain_phase::ConfiguredPhases;
use crate::host::memory_jobs::profile_consolidation::ProfileConsolidation;
use crate::host::memory_jobs::transcript_sync::LegacySessionSync;
use crate::host::{DateParser, EmbeddingOwner, SystemIdentity};

pub(in crate::host) struct DailyCognitionJobs {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    consumer: Arc<MemorySyncConsumer>,
    capsules: Arc<ProjectCapsuleService>,
    generic: CycleService,
    legacy: LegacySessionSync,
}

pub(in crate::host) struct DailyCognitionOwners {
    pub(in crate::host) data_root: PathBuf,
    pub(in crate::host) paths: CognitionPathEnvironment,
    pub(in crate::host) coordinator: Arc<CognitionWriteCoordinator>,
    pub(in crate::host) metrics: Arc<MetricFiles>,
    pub(in crate::host) consumer: Arc<MemorySyncConsumer>,
    pub(in crate::host) capsules: Arc<ProjectCapsuleService>,
    pub(in crate::host) provider: Arc<ModelProvider>,
    pub(in crate::host) configuration: Arc<ModelConfiguration>,
    pub(in crate::host) profile: Arc<ProfileService>,
    pub(in crate::host) ledger: ProjectLedger,
    pub(in crate::host) date_parser: Arc<DateParser>,
    pub(in crate::host) bindings: SessionBindingStore,
    pub(in crate::host) embedding: Arc<EmbeddingOwner>,
}

impl DailyCognitionJobs {
    pub(in crate::host) fn new(owners: DailyCognitionOwners) -> Self {
        let DailyCognitionOwners {
            data_root,
            paths,
            coordinator,
            metrics,
            consumer,
            capsules,
            provider,
            configuration,
            profile,
            ledger,
            date_parser,
            bindings,
            embedding,
        } = owners;
        let legacy = LegacySessionSync::new(
            data_root.clone(),
            paths.clone(),
            coordinator.clone(),
            bindings,
            provider.clone(),
            embedding,
        );
        let feedback = Arc::new(FeedbackBufferService::new(
            data_root.clone(),
            paths.clone(),
            coordinator.clone(),
        ));
        let knowhow = Arc::new(KnowHowService::new(
            data_root.clone(),
            paths.clone(),
            coordinator.clone(),
        ));
        let cycle_metrics = Arc::new(CycleMetrics::new(metrics));
        let briefing = Arc::new(BriefingGeneration::from_runtime(
            data_root.clone(),
            coordinator.clone(),
            provider.clone(),
            configuration,
            profile.clone(),
            ledger,
            date_parser,
            paths.clone(),
        ));
        let phases = Arc::new(CyclePhases {
            metrics: cycle_metrics.clone(),
            briefing,
            profile: Arc::new(ProfileConsolidation {
                provider,
                rules: feedback_rules(&data_root, &paths, coordinator.clone()),
                profile,
                feedback: feedback.clone(),
            }),
            legacy_metadata: Arc::new(LegacyMetadataIntegrityService::new(
                &data_root.clone(),
                paths.clone(),
                feedback.clone(),
            )),
            feedback,
            knowhow,
            health: feedback_health(&data_root, &paths, coordinator.clone()),
        });
        let generic = CycleService::new(
            data_root.clone(),
            paths.clone(),
            coordinator.clone(),
            Arc::new(SystemIdentity),
            phases,
            cycle_metrics,
        );
        Self {
            data_root,
            paths,
            coordinator,
            consumer,
            capsules,
            generic,
            legacy,
        }
    }

    pub(in crate::host) async fn session_sync(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), crate::host::HostError> {
        if cancellation.is_cancelled() {
            return Err("memory_write_aborted".into());
        }
        if !active_memory_descriptor_exists(&self.data_root, &self.paths)
            .map_err(|error| error.code().to_owned())?
        {
            return self.legacy.run(cancellation).await;
        }
        let result = self
            .consumer
            .catchup_once(cancellation)
            .await
            .map_err(|error| error.code().to_owned())?;
        butler_core::diagnostic!(
            "[session-sync] available={} scanned={} ingested={} wrapped={}",
            result.available,
            result.scanned,
            result.ingested,
            result.wrapped,
        );
        Ok(())
    }

    pub(in crate::host) async fn manual_feedback(
        &self,
        input: serde_json::Value,
        cancellation: CancellationToken,
    ) -> Result<serde_json::Value, crate::host::HostError> {
        let result = self
            .generic
            .run(feedback_run(&input, cancellation)?)
            .await
            .map_err(crate::host::HostError::from_error)?;
        serde_json::to_value(result).map_err(crate::host::HostError::from_error)
    }

    pub(in crate::host) async fn consolidation_cycle(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), crate::host::HostError> {
        if cancellation.is_cancelled() {
            return Err("memory_write_aborted".into());
        }
        if active_memory_descriptor_exists(&self.data_root, &self.paths)
            .map_err(|error| error.code().to_owned())?
            && let Err(error) = self.consumer.drain_vectors(cancellation).await
        {
            if cancellation.is_cancelled() {
                return Err("memory_write_aborted".into());
            }
            // Unavailable embeddings must not prevent text/cache maintenance.
            // Unit retry/failure state remains durable and visible in health.
            butler_core::diagnostic!("[memory-vector-batch] {}", error.code());
        }
        let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
        let run_id = format!(
            "cr_scheduled_{}_{}",
            now.format("%Y%m%d%H%M%S"),
            uuid::Uuid::new_v4().simple()
        );
        let generic = self
            .generic
            .run(RunCycle {
                run_id: Some(run_id),
                cancellation: cancellation.clone(),
                ..RunCycle::default()
            })
            .await
            .map_err(|error| error.code().to_owned())?;
        let configured = self.run_configured(cancellation).await?;
        let generic_ok = matches!(
            generic.status,
            CycleStatus::Completed | CycleStatus::DeferredRateLimited | CycleStatus::LockHeld
        );
        let completed = generic_ok && configured.exit_code == 0;
        butler_core::diagnostic!(
            "[consolidation-cycle] status={} generic={:?} genericPhases={} configuredPhases={} configuredErrors={}",
            if completed {
                "completed"
            } else {
                "completed_with_errors"
            },
            generic.status,
            generic.phases.len(),
            configured.phases_run,
            configured.failed_phases.join(","),
        );
        if completed {
            Ok(())
        } else {
            Err("scheduled_consolidation_completed_with_errors".into())
        }
    }

    async fn run_configured(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<ConfiguredCycleResult, crate::host::HostError> {
        let config = ConfiguredCycleOptions::load(&self.data_root);
        if !config.enabled
            || !active_memory_descriptor_exists(&self.data_root, &self.paths)
                .map_err(|error| error.code().to_owned())?
        {
            return Ok(ConfiguredCycleResult::skipped());
        }
        let generation = resolve_active_generation(&self.data_root, &self.paths)
            .map_err(|error| error.code().to_owned())?;
        let phases = Arc::new(ConfiguredPhases {
            consumer: self.consumer.clone(),
            consolidate: GraphConsolidationService::new(
                self.data_root.clone(),
                self.paths.clone(),
                self.coordinator.clone(),
            ),
            optimize: VectorOptimizeService::new(
                self.data_root.clone(),
                self.paths.clone(),
                self.coordinator.clone(),
            ),
            capsules: self.capsules.clone(),
            health: MemoryHealthService::new(
                self.data_root.clone(),
                self.paths.clone(),
                self.coordinator.clone(),
            ),
            generation_id: generation.generation_id,
            activation_decay_d: config.activation_decay_d,
            project_capsule_refresh_limit: config.project_capsule_refresh_limit,
        });
        ConfiguredCycleService::new(self.data_root.clone(), self.paths.clone(), phases)
            .run(&config, cancellation)
            .await
            .map_err(|error| error.code().to_owned())
            .map_err(crate::host::HostError::from)
    }
}

fn feedback_rules(
    data: &std::path::Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
) -> butler_memory::cognition::RememberedRuleOwner {
    let clock =
        Arc::new(|| butler_models::models::ModelConfigurationClock::now_iso(&SystemIdentity));
    let publisher = Arc::new(butler_memory::cognition::CompletionPublisher::new(
        data, paths, clock,
    ));
    super::rule_checkpoints::configure(
        butler_memory::cognition::RememberedRuleOwner::new(
            data.to_owned(),
            paths.clone(),
            coordinator,
            publisher,
        ),
        data,
    )
}

fn feedback_health(
    root: &std::path::Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
) -> Arc<MemoryHealthService> {
    Arc::new(MemoryHealthService::new(
        root.to_path_buf(),
        paths.clone(),
        coordinator,
    ))
}

fn feedback_run(
    input: &serde_json::Value,
    cancellation: CancellationToken,
) -> Result<RunCycle, crate::host::HostError> {
    let budget = input
        .get("rate_budget")
        .map(|value| serde_json::from_value::<butler_memory::cognition::RateBudget>(value.clone()))
        .transpose()
        .map_err(crate::host::HostError::from_error)?;
    Ok(RunCycle {
        run_id: input
            .get("run_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        resume: input
            .get("resume")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        rate_budget: Arc::new(move || budget.clone()),
        stop_after: Some(butler_memory::cognition::Phase::FeedbackTriage),
        cancellation,
    })
}

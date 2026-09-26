//! The two source 04:00 jobs over the live process's existing owners.

use std::{path::PathBuf, sync::Arc, time::SystemTime};

use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        BoxStoreService, CognitionPathEnvironment, ConfiguredCycleOptions, ConfiguredCycleResult,
        ConfiguredCycleService, CycleService, CycleStatus, FeedbackBufferService,
        GraphConsolidationService, KnowHowService, LegacyMetadataIntegrityService,
        MemoryHealthService, NativeMemorySyncConsumer, NativeVectorOptimizeService,
        ProjectCapsuleService, RunCycle, active_memory_descriptor_exists,
        resolve_active_generation,
    },
    coordination::CognitionWriteCoordinator,
    models::{ModelConfiguration, NativeModelProvider},
    operations::{CycleMetrics, MetricFiles},
    profile::ProfileService,
    project_ledger::NativeProjectLedger,
    workspace::SessionBindingStore,
};

use super::{
    NativeDateParser, NativeEmbeddingOwner, SystemIdentity,
    briefing_generation::NativeBriefingGeneration, consolidation_phase::NativeCyclePhases,
    legacy_session_sync::NativeLegacySessionSync, memory_maintain_phase::NativeConfiguredPhases,
    profile_consolidation::ProfileConsolidation,
};

pub(super) struct DailyCognitionJobs {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    consumer: Arc<NativeMemorySyncConsumer>,
    capsules: Arc<ProjectCapsuleService>,
    generic: CycleService,
    legacy: NativeLegacySessionSync,
}

pub(super) struct DailyCognitionOwners {
    pub(super) data_root: PathBuf,
    pub(super) paths: CognitionPathEnvironment,
    pub(super) coordinator: Arc<CognitionWriteCoordinator>,
    pub(super) metrics: Arc<MetricFiles>,
    pub(super) consumer: Arc<NativeMemorySyncConsumer>,
    pub(super) capsules: Arc<ProjectCapsuleService>,
    pub(super) provider: Arc<NativeModelProvider>,
    pub(super) configuration: Arc<ModelConfiguration>,
    pub(super) profile: Arc<ProfileService>,
    pub(super) ledger: NativeProjectLedger,
    pub(super) date_parser: Arc<NativeDateParser>,
    pub(super) bindings: SessionBindingStore,
    pub(super) embedding: Arc<NativeEmbeddingOwner>,
}

impl DailyCognitionJobs {
    pub(super) fn new(owners: DailyCognitionOwners) -> Self {
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
        let legacy = NativeLegacySessionSync::new(
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
        let box_store = Arc::new(BoxStoreService::new(
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
        let briefing = Arc::new(NativeBriefingGeneration::from_runtime(
            data_root.clone(),
            coordinator.clone(),
            provider,
            configuration,
            profile.clone(),
            ledger,
            date_parser,
            paths.clone(),
        ));
        let phases = Arc::new(NativeCyclePhases {
            metrics: cycle_metrics.clone(),
            briefing,
            profile: Arc::new(ProfileConsolidation {
                profile,
                feedback: feedback.clone(),
            }),
            legacy_metadata: Arc::new(LegacyMetadataIntegrityService::new(
                data_root.clone(),
                paths.clone(),
                box_store.clone(),
                feedback.clone(),
            )),
            feedback,
            knowhow,
            health: Arc::new(MemoryHealthService::new(
                data_root.clone(),
                paths.clone(),
                coordinator.clone(),
            )),
            box_store,
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

    pub(super) async fn session_sync(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        if cancellation.is_cancelled() {
            return Err("memory_write_aborted".into());
        }
        if !active_memory_descriptor_exists(&self.data_root, &self.paths)
            .map_err(|error| error.code.to_owned())?
        {
            return self.legacy.run(cancellation).await;
        }
        let result = self
            .consumer
            .catchup_once(cancellation)
            .await
            .map_err(|error| error.code.to_owned())?;
        println!(
            "[session-sync] available={} scanned={} ingested={} wrapped={}",
            result.available, result.scanned, result.ingested, result.wrapped,
        );
        Ok(())
    }

    pub(super) async fn consolidation_cycle(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        if cancellation.is_cancelled() {
            return Err("memory_write_aborted".into());
        }
        let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
        let run_id = format!("cr_scheduled_{}", now.format("%Y%m%d%H%M%S"));
        let generic = self
            .generic
            .run(RunCycle {
                run_id: Some(run_id),
                cancellation: cancellation.clone(),
                ..RunCycle::default()
            })
            .await
            .map_err(|error| error.code.to_owned())?;
        let configured = self.run_configured(cancellation).await?;
        let generic_ok = matches!(
            generic.status,
            CycleStatus::Completed | CycleStatus::DeferredRateLimited | CycleStatus::LockHeld
        );
        let completed = generic_ok && configured.exit_code == 0;
        println!(
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
    ) -> Result<ConfiguredCycleResult, String> {
        let config = ConfiguredCycleOptions::load(&self.data_root);
        if !config.enabled
            || !active_memory_descriptor_exists(&self.data_root, &self.paths)
                .map_err(|error| error.code.to_owned())?
        {
            return Ok(ConfiguredCycleResult::skipped());
        }
        let generation = resolve_active_generation(&self.data_root, &self.paths)
            .map_err(|error| error.code.to_owned())?;
        let phases = Arc::new(NativeConfiguredPhases {
            consumer: self.consumer.clone(),
            consolidate: GraphConsolidationService::new(
                self.data_root.clone(),
                self.paths.clone(),
                self.coordinator.clone(),
            ),
            optimize: NativeVectorOptimizeService::new(
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
            .map_err(|error| error.code.to_owned())
    }
}

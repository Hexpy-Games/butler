//! Shared dependencies for one change-driven memory-consumer quantum.

use crate::cognition::{
    CognitionEmbeddingPort, CognitionPathEnvironment, CognitionRegistrationService,
    MemoryGenerationTarget,
};
use crate::coordination::CognitionWriteCoordinator;
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(in super::super) struct Input {
    pub instruction_owner: crate::cognition::RememberedRuleOwner,
    pub data_root: PathBuf,
    pub environment: CognitionPathEnvironment,
    pub registration: Arc<CognitionRegistrationService>,
    pub embedding: Option<Arc<dyn CognitionEmbeddingPort>>,
    pub target: Option<MemoryGenerationTarget>,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub clock: Arc<dyn Fn() -> String + Send + Sync>,
    pub catchup_at: Arc<Mutex<Option<Instant>>>,
    pub unclean_start: Arc<AtomicBool>,
    pub catchup_progress: Arc<Mutex<Option<(PathBuf, crate::cognition::graph::CatchupState)>>>,
    pub probe: Arc<super::super::probe::ProbeReader>,
    pub vector_batch: Arc<AtomicBool>,
    pub daily_batch: bool,
    pub shutdown: CancellationToken,
}

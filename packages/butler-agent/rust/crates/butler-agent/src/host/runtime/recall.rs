use super::{RuntimePaths, SystemIdentity, models};
use butler_core::locale::LocaleCollation;
use butler_memory::cognition::MemoryRecall;
use butler_models::models::ModelConfigurationClock;
use std::sync::Arc;

pub(super) fn configured_recall(
    paths: &RuntimePaths,
    environment: &butler_memory::cognition::CognitionPathEnvironment,
    models: &models::ProcessModels,
    date_parser: Arc<crate::host::DateParser>,
    collation: Arc<LocaleCollation>,
) -> MemoryRecall {
    let source = crate::host::memory_jobs::recall_judge::RecallJudge::new(
        models.configuration.clone(),
        &paths.data_root,
    );
    MemoryRecall::new(
        paths.data_root.clone(),
        environment.clone(),
        Arc::new(move |value| date_parser.parse(value)),
        Arc::new(move |left, right| collation.compare(left, right)),
        Arc::new(|| SystemIdentity.now_epoch_millis()),
        2,
    )
    .with_judge_port(Arc::new(
        butler_memory::cognition::ConfiguredRecallJudge::new(
            models.provider.clone(),
            Arc::new(source),
        ),
    ))
}

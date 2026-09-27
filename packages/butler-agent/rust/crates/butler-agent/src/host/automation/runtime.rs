use std::{path::Path, sync::Arc, time::Duration};

use butler_gateway::gateway::InboundQueue;
use butler_runtime::operations::AutomationService;

use crate::host::{AutomationQueue, DateParser, SystemIdentity};
use butler_models::models::ModelConfigurationClock;

pub(crate) fn open_automation_service(
    data_root: &Path,
    parser: Arc<DateParser>,
    queue: Arc<InboundQueue>,
) -> Arc<AutomationService> {
    AutomationService::open(
        data_root,
        butler_runtime::operations::AutomationDependencies {
            parse_date: Arc::new(move |value| parser.parse(value)),
            now_millis: Arc::new(|| SystemIdentity.now_epoch_millis()),
            enqueue: Arc::new(AutomationQueue(queue)),
            scheduler_interval: Duration::from_secs(60),
        },
    )
}

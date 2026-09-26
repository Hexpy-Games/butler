use std::{path::Path, sync::Arc, time::Duration};

use crate::{gateway::NativeInboundQueue, operations::NativeAutomationService};

use super::{NativeAutomationQueue, NativeDateParser, SystemIdentity};
use crate::models::ModelConfigurationClock;

pub(crate) fn open_automation_service(
    data_root: &Path,
    parser: Arc<NativeDateParser>,
    queue: Arc<NativeInboundQueue>,
) -> Arc<NativeAutomationService> {
    NativeAutomationService::open(
        data_root,
        crate::operations::AutomationDependencies {
            parse_date: Arc::new(move |value| parser.parse(value)),
            now_millis: Arc::new(|| SystemIdentity.now_epoch_millis()),
            enqueue: Arc::new(NativeAutomationQueue(queue)),
            scheduler_interval: Duration::from_secs(60),
        },
    )
}

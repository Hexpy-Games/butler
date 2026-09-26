//! Native monitor reads projected from Operations and existing BTCC owners.

mod events;
mod logs;
mod work_status;

use std::{path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use crate::{
    btcc::SessionWorkRepository,
    gateway::{
        AppBoundWorkStatusFact, AppDeveloperLogsQuery, AppMonitorPage, AppMonitoringPort,
        AppUsageMonitorQuery, ApplicationFuture,
    },
};

pub(crate) struct NativeAppMonitoring {
    data_root: PathBuf,
    session_work: Arc<SessionWorkRepository>,
}

impl NativeAppMonitoring {
    pub(crate) fn new(data_root: PathBuf, session_work: Arc<SessionWorkRepository>) -> Self {
        Self {
            data_root,
            session_work,
        }
    }
}

impl AppMonitoringPort for NativeAppMonitoring {
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>> {
        let session_work = self.session_work.clone();
        Box::pin(async move { work_status::read(session_work).await })
    }

    fn usage_monitor(&self, query: AppUsageMonitorQuery) -> ApplicationFuture<Value> {
        let root = self.data_root.clone();
        Box::pin(async move {
            let mut view = crate::operations::read_usage_monitor(
                &root,
                query.session_id.as_deref(),
                query.since_ts,
            );
            if let Some(object) = view.as_object_mut() {
                object.insert("generated_at".into(), json!(now_iso()));
                object.insert("raw_text_included".into(), json!(false));
            }
            Ok(view)
        })
    }

    fn system_events(&self, page: AppMonitorPage) -> ApplicationFuture<Value> {
        let root = self.data_root.clone();
        Box::pin(async move { Ok(events::read(&root, page)) })
    }

    fn developer_logs(&self, query: AppDeveloperLogsQuery) -> ApplicationFuture<Value> {
        let root = self.data_root.clone();
        Box::pin(async move { logs::read(&root, &query) })
    }
}

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

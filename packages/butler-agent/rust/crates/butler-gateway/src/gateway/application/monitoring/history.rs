//! One indexed title lookup after the native activity projection.
use crate::gateway::{AppApplication, ApplicationFuture};
use serde_json::Value;

pub(in crate::gateway::application) fn read(this: AppApplication) -> ApplicationFuture<Value> {
    Box::pin(async move {
        let mut view = this.dependencies.monitoring.usage_history().await?;
        this.storage
            .read(move |db| {
                super::usage::enrich_history(db, &mut view)?;
                Ok(view)
            })
            .await
            .map_err(super::super::app_error)
    })
}

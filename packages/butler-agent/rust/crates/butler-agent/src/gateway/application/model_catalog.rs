//! Typed operations for the existing Models owner exposed by the App API.

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::gateway::ApplicationFuture;

pub(crate) enum AppModelCatalogCommand {
    Read,
    UpsertCredential(Value),
    RegisterHosted(Value),
    DeleteHosted(String),
    DiscoverLocal(Value),
    RegisterLocal(Value),
    UpdateLocal { lookup: String, input: Value },
    DeleteLocal(String),
}

pub(crate) trait AppModelCatalogPort: Send + Sync + 'static {
    fn execute(
        &self,
        command: AppModelCatalogCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value>;
}

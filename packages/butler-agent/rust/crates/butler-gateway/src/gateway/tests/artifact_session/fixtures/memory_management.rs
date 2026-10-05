use crate::gateway::{AppMemoryCommand, AppMemoryPort, ApplicationFuture, MemoryEventSink};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub(super) struct TestMemory;
impl AppMemoryPort for TestMemory {
    fn execute(
        &self,
        _: AppMemoryCommand,
        _: MemoryEventSink,
        _: CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(Value::Null) })
    }
}

use super::*;

impl AppPersonalizationPort for Personalization {
    fn execute(
        &self,
        _: AppPersonalizationCommand,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<AppPersonalizationResult> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}

impl AppMemoryPort for Personalization {
    fn execute(
        &self,
        _: AppMemoryCommand,
        _: MemoryEventSink,
        _: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(Value::Null) })
    }
}

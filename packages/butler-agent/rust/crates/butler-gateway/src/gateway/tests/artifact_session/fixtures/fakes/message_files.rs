use super::*;

impl AppMessageFileStorage for TestMaterializer {
    fn replace_browser_still(
        &self,
        _: crate::gateway::AppMessageFileSnapshot,
        _: bytes::Bytes,
        _: String,
    ) -> ApplicationFuture<MaterializedResponderFile> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn write_upload(&self, _: AppFileWrite) -> ApplicationFuture<MaterializedResponderFile> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn prepare_uploaded(&self, _: AppMessageFileSnapshot) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn read_original(&self, _: AppMessageFileSnapshot) -> ApplicationFuture<Bytes> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}

//! File jobs stay outside App SQLite and run on the bounded blocking lane.
use super::{AppFileWrite, AppMessageFileSnapshot, ApplicationFuture, MaterializedResponderFile};
use bytes::Bytes;

pub trait AppMessageFileStorage: Send + Sync + 'static {
    fn remove_original(&self, id: String) -> ApplicationFuture<()>;
    fn replace_browser_still(
        &self,
        file: AppMessageFileSnapshot,
        bytes: Bytes,
        name: String,
    ) -> ApplicationFuture<MaterializedResponderFile>;
    fn write_upload(&self, input: AppFileWrite) -> ApplicationFuture<MaterializedResponderFile>;
    fn prepare_uploaded(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<()>;
    fn read_original(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<Bytes>;
}

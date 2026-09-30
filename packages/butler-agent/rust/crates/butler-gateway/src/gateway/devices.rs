//! Durable device credentials. Secrets never leave the cookie issuance path.
use super::ApplicationFuture;
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct PairedDevice {
    pub id: String,
    #[serde(skip_serializing)]
    pub secret_hash: Vec<u8>,
    pub name: String,
    pub ip: String,
    pub created_at: u64,
    pub last_seen_at: u64,
    pub revoked_at: Option<u64>,
}

pub trait GatewayDevices: Send + Sync {
    fn load_devices(&self) -> ApplicationFuture<Vec<PairedDevice>>;
    fn save_device(&self, device: PairedDevice) -> ApplicationFuture<()>;
    fn revoke_devices(&self, id: Option<String>, now: u64) -> ApplicationFuture<()>;
    fn touch_device(&self, id: String, now: u64) -> ApplicationFuture<()>;
}

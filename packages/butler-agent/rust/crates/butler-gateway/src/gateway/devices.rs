//! Durable device credentials. Secrets never leave the cookie issuance path.
use super::ApplicationFuture;
use serde::Serialize;

/// How a device presents its credential: a browser cookie, or a phone's token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Browser,
    Ios,
    Android,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "browser" => Some(Self::Browser),
            "ios" => Some(Self::Ios),
            "android" => Some(Self::Android),
            _ => None,
        }
    }
}

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
    pub kind: DeviceKind,
    #[serde(skip_serializing)]
    pub noise_static: Option<[u8; 32]>,
}

/// Push event kinds a phone can choose, in canonical order.
pub(crate) const PUSH_KINDS: [&str; 4] = ["needs_input", "done", "failed", "schedule_blocked"];

pub trait GatewayDevices: Send + Sync {
    fn load_tunnel(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Ok(serde_json::Value::Null) })
    }

    fn save_tunnel(&self, _value: serde_json::Value) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }

    fn load_devices(&self) -> ApplicationFuture<Vec<PairedDevice>>;
    fn save_device(&self, device: PairedDevice) -> ApplicationFuture<()>;
    /// Stores (Some) or clears (None) a live device's push token, language and event kinds
    /// (None = all). A token is held by at most one device.
    fn set_device_push_token(
        &self,
        id: String,
        token: Option<String>,
        lang: Option<String>,
        kinds: Option<String>,
    ) -> ApplicationFuture<()>;
    fn revoke_devices(&self, id: Option<String>, now: u64) -> ApplicationFuture<()>;
    fn touch_device(&self, id: String, now: u64) -> ApplicationFuture<()>;
    /// This Butler's stable random id, created on first call.
    fn butler_id(&self) -> ApplicationFuture<String>;
}

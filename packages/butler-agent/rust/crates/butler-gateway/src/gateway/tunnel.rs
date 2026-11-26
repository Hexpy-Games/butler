//! Host-owned credentials and cloud operations for the built-in tunnel.
use super::ApplicationFuture;
use zeroize::Zeroizing;

pub struct TunnelAccount {
    pub base_url: String,
    pub qr_cloud: Option<String>,
    pub device_token: Zeroizing<String>,
}

pub trait GatewayTunnelPort: Send + Sync {
    /// The signed-in account, read locally without a cloud request.
    fn account(&self) -> ApplicationFuture<Option<TunnelAccount>>;
    /// Allocate or recover this desktop's tunnel id.
    fn allocate(&self) -> ApplicationFuture<String>;
    /// Load the static private key, creating it on first use.
    fn static_key(&self) -> ApplicationFuture<Zeroizing<[u8; 32]>>;
    /// Read the current plan from the signed-in account.
    fn plan(&self) -> ApplicationFuture<Option<String>>;
}

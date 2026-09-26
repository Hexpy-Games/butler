//! Host-owned logical lifecycle for the in-process App gateway.

mod control;
mod endpoint;
mod owner;

pub(crate) use control::GatewayControlServer;
pub(crate) use control::report_restart_handoff;
pub(crate) use endpoint::NativeActiveAppEndpoint;
pub(crate) use owner::{GatewayControlCommand, NativeAppGatewayLifecycle};

//! Host-owned logical lifecycle for the in-process App gateway.

mod control;
mod endpoint;
mod owner;

pub(crate) use control::{GatewayControlServer, report_restart_handoff};
pub(crate) use endpoint::ActiveAppEndpoint;
pub(crate) use owner::{AppGatewayLifecycle, GatewayControlCommand};

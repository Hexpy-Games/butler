//! Host-owned logical lifecycle for the in-process App gateway.

mod control;
mod endpoint;
mod owner;

pub(crate) use control::{
    ControlOwners, GatewayControlServer, memory_status, report_restart_handoff,
    request_service_stop,
};
pub(crate) use endpoint::ActiveAppEndpoint;
pub(crate) use owner::{AppGatewayLifecycle, GatewayControlCommand, local_auth_unconfigured};

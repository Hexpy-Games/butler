//! The App gateway: the local HTTP and WebSocket API the desktop App talks to.
//!
//! [`gateway`] authenticates App clients, routes HTTP requests (sessions,
//! settings, projects, skills, MCP servers, files), queues inbound messages
//! for turns and streams turn progress back. Its application layer depends
//! only on ports; the host supplies their implementations.

#[macro_use]
extern crate butler_core;

pub mod gateway;

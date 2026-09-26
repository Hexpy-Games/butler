//! Private owner for configured external MCP servers. Registry state and
//! secrets are read on demand; every operation opens and closes one rmcp
//! session scoped to the calling Turn.

mod catalog;
mod client;
mod image_capability;
mod management;
mod registry;
mod session;
mod sse_transport;
mod transport;

pub(crate) use catalog::{
    describe as describe_mcp_tool, parse_id as parse_mcp_catalog_id,
    search as search_mcp_tool_catalog,
};
pub(crate) use client::{NativeMcpClient, RegistryPathGuard};

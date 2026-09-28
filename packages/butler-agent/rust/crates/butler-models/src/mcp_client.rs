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
#[cfg(test)]
pub(crate) use sse_transport::parser_tests::parses_fragmented_multiline_events;
mod transport;

pub use catalog::{
    describe as describe_mcp_tool, parse_id as parse_mcp_catalog_id,
    search as search_mcp_tool_catalog,
};
pub use client::{McpClient, RegistryPathGuard};
pub use registry::McpRegistryError;

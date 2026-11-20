//! browser_read requires an attached Butler browser; web_read is always offered.
use butler_core::tool_protocol::ToolName;

/// Discovery's disabled reason and recovery for the reader not offered now.
pub(super) fn withheld(
    owner: &super::GuidedTools,
    name: &str,
) -> Option<(&'static str, &'static str)> {
    match (ToolName::parse(name), owner.browser_available()) {
        (Some(ToolName::BrowserRead), false) => Some((
            "The Butler browser is not attached.",
            "Read the page by url with web_read.",
        )),
        _ => None,
    }
}

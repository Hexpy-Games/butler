//! One page reader is offered at a time: browser_read while the Butler
//! browser is attached, web_read otherwise.
use butler_core::tool_protocol::ToolName;

/// Discovery's disabled reason and recovery for the reader not offered now.
pub(super) fn withheld(
    owner: &super::GuidedTools,
    name: &str,
) -> Option<(&'static str, &'static str)> {
    match (ToolName::parse(name), owner.browser_available()) {
        (Some(ToolName::WebRead), true) => Some((
            "Pages are read in the Butler browser while it is attached.",
            "Open the page in a browser tab, then read it with browser_read.",
        )),
        (Some(ToolName::BrowserRead), false) => Some((
            "The Butler browser is not attached.",
            "Read the page by url with web_read.",
        )),
        _ => None,
    }
}

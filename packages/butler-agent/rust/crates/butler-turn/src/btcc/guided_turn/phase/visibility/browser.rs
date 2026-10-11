use super::*;
/// Conversation browser effects have their own durable authority lane, not a Work plan.
pub(super) fn authorize(
    names: &mut HashSet<String>,
    catalog: &GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    worker: bool,
) {
    if policy.access_mode != AccessMode::ReadOnly {
        for name in ["preview_start", "preview_stop"] {
            if catalog.tool(name).is_some() {
                names.insert(name.into());
            }
        }
    }
    if worker {
        return;
    }
    for name in [
        "browser_open",
        "browser_observe",
        "browser_act",
        "browser_tabs",
        "browser_selection",
        "browser_screenshot",
        "browser_close",
        "browser_wait_for_user",
        "browser_sign_in",
    ] {
        if catalog.tool(name).is_some()
            && (!matches!(name, "browser_act" | "browser_sign_in")
                || policy.access_mode != AccessMode::ReadOnly)
        {
            names.insert(name.into());
        }
    }
}

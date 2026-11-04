use super::*;
/// Conversation browser tools have their own durable authority lane, not a Work plan; Workers get the read-only ones.
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
    for name in [
        "browser_open",
        "browser_observe",
        "browser_read",
        "browser_act",
        "browser_tabs",
        "browser_selection",
        "browser_devtools",
        "browser_screenshot",
        "image_collect",
        "browser_close",
        "browser_wait_for_user",
        "browser_sign_in",
        "browser_pay_fill",
        "browser_autofill_fill",
    ] {
        let Some(tool) = catalog.tool(name) else {
            continue;
        };
        // Reading a page in a tab is a read, like web_read: every role may. Acting in one stays with Butler and its Steward.
        let reads = tool.effect_boundary.as_deref() == Some("none");
        let ask_free = !matches!(
            name,
            "browser_act" | "browser_sign_in" | "browser_pay_fill" | "browser_autofill_fill"
        ) || policy.access_mode != AccessMode::ReadOnly;
        if reads || !worker && ask_free {
            names.insert(name.into());
        }
    }
}

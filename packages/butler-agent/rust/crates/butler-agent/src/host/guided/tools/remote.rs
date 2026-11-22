//! Capabilities another Butler's remote computer does not offer: browser, dev-server preview, schedules.
const UNAVAILABLE: &[&str] = &[
    "browse",
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
    "browser_history_search",
    "preview_start",
    "preview_stop",
    "create_automation",
    "update_automation",
    "delete_automation",
    "list_automations",
    "run_due_automations",
];

pub(super) fn unavailable(name: &str) -> bool {
    butler_models::models::sealed::is_enabled() && UNAVAILABLE.contains(&name)
}

//! Preserve API-family precedence, including unknown paths, before UI fallback.
use super::{super::*, Handler};

pub(super) fn handler(request: &Request<Body>) -> Option<Handler> {
    let path = request.uri().path();
    let family = [
        (family(path, "/logs"), Handler::Logs),
        (family(path, "/library"), Handler::Library),
        (family(path, "/documents"), Handler::Documents),
        (family(path, "/browser-history"), Handler::History),
        (family(path, "/browser-stills"), Handler::BrowserStills),
        (path.starts_with("/internal/browser"), Handler::Browser),
        (path.starts_with("/__o/"), Handler::NotFound),
        (path.starts_with("/previews/"), Handler::Preview),
        (path.starts_with("/outputs/"), Handler::Output),
        (family(path, "/security"), Handler::Security),
        (family(path, "/hooks"), Handler::Hooks),
        (
            family(path, "/plugins")
                || family(path, "/plugin-registries")
                || family(path, "/connectors")
                || family(path, "/connector-rules"),
            Handler::Plugins,
        ),
    ]
    .into_iter()
    .find_map(|(matches, handler)| matches.then_some(handler));
    family.or_else(|| commands(request))
}
fn family(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}
fn commands(request: &Request<Body>) -> Option<Handler> {
    let path = request.uri().path();
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if matches!(
        parts.as_slice(),
        ["canon", "epics", _, "conversation"]
            | ["projects", _, "canon", "sidebar" | "sidebar-order"]
    ) {
        return Some(Handler::CanonSidebar);
    }
    if matches!(
        parts.as_slice(),
        ["pending-asks"]
            | ["sessions", _, "pending-asks"]
            | ["sessions", _, "pending-asks", _, "dismiss"]
    ) {
        return Some(Handler::PendingAsks);
    }
    let routes = [
        (
            matches!(
                parts.as_slice(),
                ["canon", "list" | "mcp-grants"]
                    | ["canon", "mcp-grants", _, "allow" | "deny" | "revoke"]
                    | ["canon", "specs", _, "proposals"]
                    | ["canon", "epics", _, "comments" | "activity" | "progress"]
                    | ["sessions", _, "canon", _]
                    | ["sessions", _, "canon", "queue", "edits"]
                    | ["sessions", _, "canon", "queue", "holds" | "take", _]
                    | ["projects", _, "canon"]
                    | ["projects", _, "canon", "plans" | "epics" | "tags" | "files"]
                    | ["projects", _, "canon", "backlog", "order"]
                    | [
                        "canon",
                        "specs" | "proposals" | "plans" | "epics" | "tags",
                        _
                    ]
                    | ["canon", "plans", _, "order"]
            ),
            Handler::Canon,
        ),
        (
            matches!(
                parts.as_slice(),
                ["sessions", _, "task-graphs"]
                    | ["plans", _, "task-graph"]
                    | ["tasks", _, "document"]
            ),
            Handler::TaskGraphs,
        ),
        (
            matches!(
                path,
                "/session-view" | "/session-summary" | "/context-details"
            ) || path.starts_with("/steward-relations/"),
            Handler::Subsessions,
        ),
        (
            path.starts_with("/authority-requests") || path.starts_with("/authority-permissions"),
            Handler::Authority,
        ),
        (family(path, "/model-catalog"), Handler::Models),
        (
            matches!(path.split('/').nth(1), Some("memory" | "personalization")),
            Handler::Personalization,
        ),
    ];
    routes
        .into_iter()
        .find_map(|(matches, handler)| matches.then_some(handler))
        .or_else(|| monitors(request))
}
fn monitors(request: &Request<Body>) -> Option<Handler> {
    let path = request.uri().path();
    let routes = [
        (
            matches!(
                path,
                "/usage-history"
                    | "/usage-monitor"
                    | "/work-status"
                    | "/worker-activity"
                    | "/system-events"
            ) || path.starts_with("/worker-activity/")
                || (path.starts_with("/sessions/") && path.contains("/worker-activity")),
            Handler::Monitors,
        ),
        (path.starts_with("/space/"), Handler::Space),
        (
            path.starts_with("/projects/") && path.contains("/dashboard"),
            Handler::Dashboard,
        ),
        (
            path.starts_with("/sessions/")
                && (path.ends_with("/controls") || path.contains("/plan-decisions/")),
            Handler::Controls,
        ),
        (
            path.starts_with("/projects/") || path.starts_with("/sessions/"),
            Handler::ProjectSession,
        ),
        (family(path, "/automations"), Handler::Automations),
        (
            request.method() == Method::GET && path.starts_with("/message-assets/"),
            Handler::MessageFiles,
        ),
        (
            path == "/wallpapers"
                || path.starts_with("/wallpapers/")
                || matches!(
                    path,
                    "/internal/wallpapers/from-message-file" | "/internal/wallpaper"
                )
                || wallpaper_modules::handles(path),
            Handler::Wallpapers,
        ),
    ];
    routes
        .into_iter()
        .find_map(|(matches, handler)| matches.then_some(handler))
        .or_else(|| mutations(request))
}
fn mutations(request: &Request<Body>) -> Option<Handler> {
    let path = request.uri().path();
    let routes = [
        (
            matches!(*request.method(), Method::PATCH | Method::DELETE)
                && path
                    .strip_prefix("/session-queue/")
                    .is_some_and(|id| !id.is_empty() && !id.contains('/'))
                || *request.method() == Method::POST
                    && path
                        .strip_prefix("/session-queue/")
                        .and_then(|tail| tail.strip_suffix("/send-now"))
                        .is_some_and(|id| !id.is_empty() && !id.contains('/')),
            Handler::Queue,
        ),
        (
            matches!(path, "/mcp-servers" | "/mcp-capabilities")
                || path.starts_with("/mcp-servers/"),
            Handler::Mcp,
        ),
        (
            path.starts_with("/turns/") && path.contains("/operations/"),
            Handler::Operation,
        ),
        (
            path.starts_with("/turns/") && path.contains("/retry"),
            Handler::Retry,
        ),
        (
            path.starts_with("/setup/") || family(path, "/credentials"),
            Handler::Setup,
        ),
    ];
    routes
        .into_iter()
        .find_map(|(matches, handler)| matches.then_some(handler))
        .or_else(|| request.extensions().get::<Handler>().copied())
}

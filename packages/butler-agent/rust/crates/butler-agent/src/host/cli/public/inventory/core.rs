use super::Entry;

pub(super) const ROUTES: &[Entry] = &[
    route!(
        "help",
        "butler help [command]",
        "Show native command help.",
        "core"
    ),
    route!(
        "commands",
        "butler commands [--json]",
        "List dispatched native commands.",
        "core"
    ),
    route!(
        "version",
        "butler version [--json]",
        "Show installed native manifest provenance.",
        "core"
    ),
    route!(
        "start",
        "butler start [--dry-run] [--data PATH]",
        "Start one native service for DATA.",
        "core"
    ),
    route!(
        "stop",
        "butler stop [--data PATH]",
        "Stop the native service; schedules stop until it starts again.",
        "core"
    ),
    route!(
        "restart",
        "butler restart [--data PATH]",
        "Restart the native service; reports success once the new one is ready.",
        "core"
    ),
    route!(
        "open",
        "butler open [--no-browser] [--json] [--data PATH]",
        "Open the running Butler in the local browser with a one-time link.",
        "core"
    ),
    route!(
        "service.run",
        "butler service run [--data PATH]",
        "Run the native service in foreground.",
        "core"
    ),
    route!(
        "status",
        "butler status [--data PATH]",
        "Show native service and owner status.",
        "core"
    ),
    route!(
        "doctor",
        "butler doctor [--check NAME] [--data PATH]",
        "Read-only native installation diagnosis.",
        "core"
    ),
];

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
        "Stop the owned native service.",
        "core"
    ),
    route!(
        "restart",
        "butler restart [--data PATH]",
        "Restart the owned native service.",
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

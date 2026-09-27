use super::Entry;

pub(super) const ROUTES: &[Entry] = &[
    route!(
        "gateway.app",
        "butler gateway app",
        "Run the Butler App gateway owned by Butler Agent.",
        "core"
    ),
    route!(
        "gateway.list",
        "butler gateway list",
        "List the logical App gateway.",
        "operator"
    ),
    route!(
        "gateway.status",
        "butler gateway status app",
        "Read effective App gateway state.",
        "operator"
    ),
    route!(
        "gateway.inspect",
        "butler gateway inspect app",
        "Inspect App gateway settings and state.",
        "operator"
    ),
    route!(
        "gateway.enable",
        "butler gateway enable app",
        "Persist App gateway enabled setting.",
        "operator"
    ),
    route!(
        "gateway.disable",
        "butler gateway disable app",
        "Persist App gateway disabled setting.",
        "operator"
    ),
    route!(
        "gateway.configure.app",
        "butler gateway configure app [--host HOST] [--port PORT] [--db PATH]",
        "Persist App gateway configuration.",
        "operator"
    ),
    route!(
        "gateway.test",
        "butler gateway test app",
        "Test the active App listener.",
        "operator"
    ),
    route!(
        "gateway.logs",
        "butler gateway logs app [--lines N] [--follow] [--json]",
        "Read logs for the native App gateway process.",
        "operator"
    ),
    route!(
        "gateway.start",
        "butler gateway start app",
        "Start the App listener in the native process.",
        "operator"
    ),
    route!(
        "gateway.stop",
        "butler gateway stop app",
        "Stop the App listener and retain core service.",
        "operator"
    ),
    route!(
        "gateway.restart",
        "butler gateway restart app",
        "Restart the App listener and retain core service.",
        "operator"
    ),
    route!(
        "gateway.run.app",
        "butler gateway run app",
        "Run the native service with App foreground.",
        "operator"
    ),
    route!(
        "config.get",
        "butler config get KEY",
        "Read native configuration.",
        "operator"
    ),
    route!(
        "config.set",
        "butler config set KEY VALUE",
        "Set native configuration.",
        "operator"
    ),
    route!(
        "config.edit",
        "butler config edit",
        "Edit native configuration.",
        "operator"
    ),
    route!(
        "config.validate",
        "butler config validate",
        "Validate native configuration.",
        "operator"
    ),
    route!(
        "auth.status",
        "butler auth status",
        "Inspect configured model credentials without secrets.",
        "operator"
    ),
    route!(
        "auth.login",
        "butler auth login",
        "Configure native model credentials.",
        "operator"
    ),
    route!(
        "auth.logout",
        "butler auth logout",
        "Remove selected model credentials.",
        "operator"
    ),
    route!(
        "model.status",
        "butler model status",
        "Show current native model configuration.",
        "operator"
    ),
    route!(
        "model.list",
        "butler model list",
        "List native model registrations.",
        "operator"
    ),
    route!(
        "model.set",
        "butler model set MODEL",
        "Select a native model.",
        "operator"
    ),
    route!(
        "metrics.status",
        "butler metrics status",
        "Read native operational metrics summary.",
        "operator"
    ),
    route!(
        "metrics.enable",
        "butler metrics enable",
        "Enable native operational metrics.",
        "operator"
    ),
    route!(
        "metrics.disable",
        "butler metrics disable",
        "Disable native operational metrics.",
        "operator"
    ),
    route!(
        "metrics.tail",
        "butler metrics tail",
        "Read recent operational metrics.",
        "operator"
    ),
    route!(
        "logs",
        "butler logs [--service NAME]",
        "Read native service logs.",
        "operator"
    ),
    route!(
        "ps",
        "butler ps",
        "Inspect owned native processes.",
        "operator"
    ),
    route!(
        "automation.list",
        "butler automation list",
        "List configured automations.",
        "operator"
    ),
    route!(
        "automation.show",
        "butler automation show ID",
        "Inspect an automation.",
        "operator"
    ),
    route!(
        "automation.run",
        "butler automation run ID",
        "Run an automation.",
        "operator"
    ),
    route!(
        "automation.delete",
        "butler automation delete ID",
        "Delete an automation.",
        "operator"
    ),
];
